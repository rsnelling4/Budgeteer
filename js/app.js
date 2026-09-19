import { firebaseConfig, SHARED_EMAIL, PASSCODE_SALT } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  deleteDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Recurring bill/income templates seeded from a typical household bill list.
// day = day of month it's due/received. Edit freely in Settings.
const DEFAULT_CATEGORIES = [
  { name: "Rent", amount: 1716, day: 1, type: "expense" },
  { name: "Car", amount: 460, day: 13, type: "expense" },
  { name: "Insurance", amount: 77, day: 13, type: "expense" },
  { name: "Electric", amount: 275, day: 20, type: "expense" },
  { name: "Water", amount: 60, day: 6, type: "expense" },
  { name: "Sewage", amount: 60, day: 6, type: "expense" },
  { name: "Gas", amount: 30, day: 29, type: "expense" },
  { name: "Cable", amount: 130, day: 26, type: "expense" },
  { name: "Phones", amount: 90, day: 6, type: "expense" },
  { name: "Credit Card", amount: 237, day: 9, type: "expense" },
  { name: "Hulu", amount: 18, day: 23, type: "expense" },
  { name: "Netflix", amount: 18, day: 2, type: "expense" },
  { name: "Planet Fitness", amount: 105, day: 15, type: "expense" },
  { name: "Medical", amount: 90, day: 2, type: "expense" },
];

// How many months of recurring instances to keep generated ahead of / behind today.
const MONTHS_AHEAD = 3;
const MONTHS_BEHIND = 2;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const $ = (sel) => document.querySelector(sel);
const money = (n) => (n < 0 ? "-$" + Math.abs(n).toFixed(2) : "$" + n.toFixed(2));
const todayISO = () => new Date().toISOString().slice(0, 10);

// A transaction counts toward the *current* balance once its date has arrived, unless the
// user has manually overridden that (checked it early, or un-checked one that hasn't actually
// hit yet despite the date passing). `paidOverride` is null/undefined = "auto by date".
function effectivePaid(t) {
  if (t.paidOverride === true || t.paidOverride === false) return t.paidOverride;
  if (t.paid === true || t.paid === false) return t.paid; // legacy field, kept for compatibility
  return t.date <= todayISO();
}

let categories = []; // [{id, name, amount, day, type, order}]
let transactions = []; // [{id, description, amount, type, date, paid, categoryId, createdAt}]
let startingBalance = 0;
let unsubTxns = null;
let unsubCats = null;
let unsubMeta = null;
let chart = null;
let activeType = "expense";

// ---------- Gate / auth ----------

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

$("#unlock-btn").addEventListener("click", unlock);
$("#passcode-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});

async function unlock() {
  const pin = $("#passcode-input").value.trim();
  const errEl = $("#gate-error");
  errEl.textContent = "";
  if (!/^\d{5}$/.test(pin)) {
    errEl.textContent = "Enter your 5-digit passcode.";
    return;
  }
  const btn = $("#unlock-btn");
  btn.disabled = true;
  btn.textContent = "Unlocking…";
  try {
    await signInWithEmailAndPassword(auth, SHARED_EMAIL, PASSCODE_SALT + pin);
  } catch (e) {
    errEl.textContent = "Incorrect passcode.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Unlock";
  }
}

$("#lock-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#passcode-input").value = "";
    startListeners();
  } else {
    $("#gate").classList.remove("hidden");
    $("#app").classList.add("hidden");
    stopListeners();
  }
});

// ---------- Firestore listeners ----------

function startListeners() {
  unsubMeta = onSnapshot(doc(db, "meta", "settings"), (snap) => {
    startingBalance = snap.exists() ? Number(snap.data().startingBalance || 0) : 0;
    $("#starting-balance").value = startingBalance;
    render();
  });

  unsubCats = onSnapshot(query(collection(db, "categories"), orderBy("order")), async (snap) => {
    if (snap.empty) {
      await seedDefaultCategories();
      return;
    }
    categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCategoryChips();
    renderCategorySettings();
    ensureRecurringInstances();
  });

  unsubTxns = onSnapshot(query(collection(db, "transactions"), orderBy("date")), (snap) => {
    transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
    ensureRecurringInstances();
  });
}

function stopListeners() {
  if (unsubTxns) unsubTxns();
  if (unsubCats) unsubCats();
  if (unsubMeta) unsubMeta();
  transactions = [];
  categories = [];
}

async function seedDefaultCategories() {
  await Promise.all(
    DEFAULT_CATEGORIES.map((c, i) =>
      setDoc(doc(collection(db, "categories")), { ...c, order: i })
    )
  );
}

// ---------- Recurring instance generation ----------

function clampDay(year, month, day) {
  // month is 0-indexed here
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.min(day, lastDay);
}

function ymd(year, month, day) {
  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

let generatingInstances = false;
async function ensureRecurringInstances() {
  if (!categories.length || generatingInstances) return;
  generatingInstances = true;
  try {
    await ensureRecurringInstancesInner();
  } finally {
    generatingInstances = false;
  }
}

async function ensureRecurringInstancesInner() {
  const today = new Date();
  const existingKeys = new Set(
    transactions.filter((t) => t.categoryId).map((t) => `${t.categoryId}|${t.date.slice(0, 7)}`)
  );

  const writes = [];
  categories.forEach((cat) => {
    for (let offset = -MONTHS_BEHIND; offset <= MONTHS_AHEAD; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      const y = d.getFullYear();
      const m = d.getMonth();
      const monthKey = `${y}-${String(m + 1).padStart(2, "0")}`;
      const key = `${cat.id}|${monthKey}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const date = ymd(y, m, clampDay(y, m, cat.day || 1));
      writes.push(
        addDoc(collection(db, "transactions"), {
          description: cat.name,
          amount: Number(cat.amount) || 0,
          type: cat.type === "income" ? "income" : "expense",
          date,
          paidOverride: null,
          categoryId: cat.id,
          createdAt: serverTimestamp(),
        })
      );
    }
  });
  if (writes.length) await Promise.all(writes);
}

// ---------- Category chips / quick add ----------

function renderCategoryChips() {
  const wrap = $("#category-chips");
  wrap.innerHTML = "";
  categories.forEach((cat) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.textContent = cat.name;
    chip.addEventListener("click", () => {
      $("#txn-desc").value = cat.name;
      $("#txn-amount").value = cat.amount || "";
      setActiveType(cat.type === "income" ? "income" : "expense");
      $("#txn-desc").focus();
    });
    wrap.appendChild(chip);
  });
}

function setActiveType(type) {
  activeType = type;
  document.querySelectorAll(".type-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
}

// ---------- Add one-off transaction ----------

document.querySelectorAll(".type-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => setActiveType(btn.dataset.type));
});

$("#txn-date").value = todayISO();

$("#add-txn-btn").addEventListener("click", async () => {
  const desc = $("#txn-desc").value.trim();
  const amount = parseFloat($("#txn-amount").value);
  const date = $("#txn-date").value || todayISO();
  // Checking the box force-marks it paid even if the date is in the future (paid early).
  // Left unchecked, it counts toward the current balance automatically once its date arrives.
  const paidOverride = $("#txn-paid").checked ? true : null;

  if (!desc) return showToast("Add a description");
  if (!amount || amount <= 0) return showToast("Enter an amount");

  await addDoc(collection(db, "transactions"), {
    description: desc,
    amount,
    type: activeType,
    date,
    paidOverride,
    categoryId: null,
    createdAt: serverTimestamp(),
  });

  $("#txn-desc").value = "";
  $("#txn-amount").value = "";
  $("#txn-paid").checked = false;
  showToast("Added");
});

async function deleteTxn(id) {
  await deleteDoc(doc(db, "transactions", id));
}

async function toggleTxnPaid(id, paidOverride) {
  await updateDoc(doc(db, "transactions", id), { paidOverride });
}

async function updateTxnAmount(id, amount) {
  if (!amount || amount < 0) return;
  await updateDoc(doc(db, "transactions", id), { amount });
}

// ---------- Settings modal ----------

$("#settings-btn").addEventListener("click", () => $("#settings-modal").classList.remove("hidden"));
$("#settings-close").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
$("#settings-modal").addEventListener("click", (e) => {
  if (e.target.id === "settings-modal") $("#settings-modal").classList.add("hidden");
});

function renderCategorySettings() {
  const wrap = $("#category-list");
  wrap.innerHTML = "";
  categories.forEach((cat) => {
    const row = document.createElement("div");
    row.className = "cat-row";
    row.innerHTML = `
      <input type="text" value="${escapeAttr(cat.name)}" data-field="name" data-id="${cat.id}" />
      <input type="number" step="0.01" value="${cat.amount ?? 0}" data-field="amount" data-id="${cat.id}" title="Amount" />
      <span class="cat-day-wrap">day <input type="number" min="1" max="31" value="${cat.day ?? 1}" data-field="day" data-id="${cat.id}" style="width:44px" /></span>
      <select data-field="type" data-id="${cat.id}">
        <option value="expense" ${cat.type !== "income" ? "selected" : ""}>Expense</option>
        <option value="income" ${cat.type === "income" ? "selected" : ""}>Income</option>
      </select>
      <button data-del="${cat.id}" title="Remove">✕</button>
    `;
    wrap.appendChild(row);
  });
}

$("#add-cat-btn").addEventListener("click", async () => {
  const name = $("#new-cat-name").value.trim();
  const amount = parseFloat($("#new-cat-amount").value) || 0;
  const day = Math.min(31, Math.max(1, parseInt($("#new-cat-day").value, 10) || 1));
  const type = $("#new-cat-type").value;
  if (!name) return showToast("Enter a name");

  await setDoc(doc(collection(db, "categories")), { name, amount, day, type, order: categories.length });
  $("#new-cat-name").value = "";
  $("#new-cat-amount").value = "";
  $("#new-cat-day").value = "";
  showToast("Recurring item added");
});

$("#category-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.del;
  if (id) await deleteDoc(doc(db, "categories", id));
});

$("#settings-save").addEventListener("click", async () => {
  const sb = parseFloat($("#starting-balance").value) || 0;
  await setDoc(doc(db, "meta", "settings"), { startingBalance: sb }, { merge: true });

  const writes = [];
  const fields = document.querySelectorAll("#category-list [data-id]");
  const byId = new Map();
  fields.forEach((el) => {
    const id = el.dataset.id;
    if (!byId.has(id)) byId.set(id, {});
    const field = el.dataset.field;
    let val = el.value;
    if (field === "amount") val = parseFloat(val) || 0;
    if (field === "day") val = Math.min(31, Math.max(1, parseInt(val, 10) || 1));
    byId.get(id)[field] = val;
  });
  byId.forEach((patch, id) => {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    const changed = Object.keys(patch).some((k) => patch[k] !== cat[k]);
    if (changed) writes.push(setDoc(doc(db, "categories", id), patch, { merge: true }));
  });
  await Promise.all(writes);

  $("#settings-modal").classList.add("hidden");
  showToast("Saved");
});

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Rendering: current balance, projections, calendar ledger ----------

function startOfWeek(dateStr) {
  // Weeks run Monday–Sunday.
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0 = Sun
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function fmtWeekRange(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const opts = { month: "short", day: "numeric" };
  return `${monday.toLocaleDateString(undefined, opts)} – ${sunday.toLocaleDateString(undefined, opts)}`;
}

function render() {
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Current (real) balance: starting balance plus everything whose date has arrived (or that's
  // been manually marked paid/pending as an override) — i.e. what's actually hit the bank.
  let currentBalance = startingBalance;
  sorted.forEach((t) => {
    currentBalance += effectivePaid(t) ? (t.type === "income" ? t.amount : -t.amount) : 0;
  });
  $("#current-balance").textContent = money(currentBalance);

  // Projected running balance: assumes every scheduled item clears on its date, used for the
  // "balance after this" chain and the chart.
  let running = startingBalance;
  const withRunning = sorted.map((t) => {
    running += t.type === "income" ? t.amount : -t.amount;
    return { ...t, running };
  });

  // This week's stats + projected end-of-week balance.
  const thisWeekStart = startOfWeek(todayISO());
  const thisWeekStartTime = thisWeekStart.getTime();
  const thisWeekEndTime = thisWeekStartTime + 7 * 86400000;

  let weekIn = 0, weekOut = 0;
  let weekProjected = startingBalance;
  withRunning.forEach((t) => {
    const ts = new Date(t.date + "T00:00:00").getTime();
    if (ts < thisWeekEndTime) weekProjected = t.running;
    if (ts >= thisWeekStartTime && ts < thisWeekEndTime) {
      if (t.type === "income") weekIn += t.amount;
      else weekOut += t.amount;
    }
  });
  $("#week-in").textContent = money(weekIn);
  $("#week-out").textContent = money(weekOut);
  $("#week-projected").textContent = money(weekProjected);

  renderLedger(withRunning);
  renderChart(withRunning);
}

function renderLedger(withRunning) {
  const wrap = $("#ledger");
  wrap.innerHTML = "";

  if (!withRunning.length) {
    wrap.innerHTML = `<div class="empty-state">Nothing scheduled yet. Add a recurring bill in settings (⚙) or a one-off item above.</div>`;
    return;
  }

  const groups = new Map(); // key -> {monday, items:[]}
  withRunning.forEach((t) => {
    const monday = startOfWeek(t.date);
    const key = monday.toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, { monday, items: [] });
    groups.get(key).items.push(t);
  });

  const orderedKeys = [...groups.keys()].sort();
  const todayKey = startOfWeek(todayISO()).toISOString().slice(0, 10);

  orderedKeys.forEach((key) => {
    const { monday, items } = groups.get(key);
    const weekEndBalance = items[items.length - 1].running;
    const section = document.createElement("div");
    section.className = "week-group";
    const isCurrent = key === todayKey;
    section.innerHTML = `
      <div class="week-header">
        <div class="week-range">${fmtWeekRange(monday)}${isCurrent ? " · this week" : ""}</div>
        <div class="week-end-balance">Projected end ${money(weekEndBalance)}</div>
      </div>
      <div class="week-card"></div>
    `;
    const card = section.querySelector(".week-card");
    items.forEach((t) => card.appendChild(txnRow(t)));
    wrap.appendChild(section);
  });
}

function txnRow(t) {
  const row = document.createElement("div");
  row.className = "txn-row";
  const sign = t.type === "income" ? "+" : "−";
  const paid = effectivePaid(t);
  const dateLabel = new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  row.innerHTML = `
    <input type="checkbox" class="txn-check" ${paid ? "checked" : ""} title="Hit my bank (auto-checks once the date arrives; click to override)" />
    <div class="txn-main">
      <div class="txn-desc">${escapeHtml(t.description)}${!paid ? '<span class="txn-pending-badge">Pending</span>' : ""}</div>
      <div class="txn-meta">${dateLabel}</div>
    </div>
    <div class="txn-right">
      <div class="txn-amount ${t.type}">${sign}$<input type="number" step="0.01" class="txn-amount-input" value="${t.amount.toFixed(2)}" /></div>
      <div class="txn-running">bal ${money(t.running)}</div>
    </div>
    <button class="txn-del" title="Delete">✕</button>
  `;
  row.querySelector(".txn-check").addEventListener("change", (e) => toggleTxnPaid(t.id, e.target.checked));
  row.querySelector(".txn-amount-input").addEventListener("change", (e) => updateTxnAmount(t.id, parseFloat(e.target.value)));
  row.querySelector(".txn-del").addEventListener("click", () => deleteTxn(t.id));
  return row;
}

function renderChart(withRunning) {
  const ctx = document.getElementById("balance-chart");
  const points = withRunning.slice(-30);
  const labels = points.map((t) => new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "numeric", day: "numeric" }));
  const data = points.map((t) => t.running);

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update();
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: "#3b6ef6",
        backgroundColor: "rgba(59,110,246,0.08)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    },
  });
}
