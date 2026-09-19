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

// ---------------------------------------------------------------------------
// Fixed household bills & income. These are hardcoded on purpose (not editable
// in the UI) — to change an amount or date, edit this list and redeploy.
//
// frequency:
//   'monthly'  -> `day` = day of month (1-31, clamped to the month's length)
//   'weekly'   -> `weekday` = 0 (Mon) .. 6 (Sun)
//   'biweekly' -> `weekday` + `anchor` (an ISO date of one real occurrence,
//                 used to figure out which weeks it lands on)
// ---------------------------------------------------------------------------
const RECURRING_BILLS = [
  { name: "Paycheck", type: "income", frequency: "biweekly", weekday: 4, anchor: "2026-09-18", amount: 1775 },
  { name: "Contribution", type: "income", frequency: "biweekly", weekday: 4, anchor: "2026-09-11", amount: 900 },

  { name: "Affirm", type: "expense", frequency: "monthly", day: 9, amount: 125 },
  { name: "LM", type: "expense", frequency: "monthly", day: 9, amount: 19 },
  { name: "Hulu", type: "expense", frequency: "monthly", day: 23, amount: 105 },
  { name: "Netflix", type: "expense", frequency: "monthly", day: 2, amount: 20 },
  { name: "Phones", type: "expense", frequency: "monthly", day: 18, amount: 85 },
  { name: "Cable", type: "expense", frequency: "monthly", day: 24, amount: 130 },
  { name: "Elec", type: "expense", frequency: "monthly", day: 28, amount: 300 },
  { name: "Car", type: "expense", frequency: "monthly", day: 4, amount: 460 },
  { name: "Rent", type: "expense", frequency: "monthly", day: 14, amount: 1716 },
  { name: "INS", type: "expense", frequency: "monthly", day: 5, amount: 77 },
  { name: "Water", type: "expense", frequency: "monthly", day: 11, amount: 57 },
  { name: "Sewage", type: "expense", frequency: "monthly", day: 11, amount: 65 },
  { name: "Gas", type: "expense", frequency: "monthly", day: 29, amount: 30 },
  { name: "CC", type: "expense", frequency: "monthly", day: 29, amount: 237 },
];

// How many weeks of the ledger to compute ahead of today, and how many to show in the
// table by default (with a "Show more" button revealing more, in increments, up to the cap).
const WEEKS_AHEAD = 52;
const WEEKS_VISIBLE_DEFAULT = 12;
const WEEKS_VISIBLE_STEP = 12;

// The default starting balance + "as of" date, used the very first time the app runs
// (i.e. meta/settings doesn't exist yet in Firestore). After that, Settings owns it.
const DEFAULT_STARTING_BALANCE = 3848.67;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const $ = (sel) => document.querySelector(sel);
const money = (n) => (n < 0 ? "-$" + Math.abs(n).toFixed(2) : "$" + n.toFixed(2));
const todayISO = () => new Date().toISOString().slice(0, 10);

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

// ---------- Date helpers ----------
// Pay periods land on Fridays, so the budgeting week runs Friday -> Thursday.
// `weekStart(d)` returns that week's Friday (0 offset if `d` itself is a Friday).

function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0 = Sun .. 6 = Sat
  const diff = (day - 5 + 7) % 7; // days since the most recent Friday
  d.setDate(d.getDate() - diff);
  return d;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function dateToISO(d) {
  return d.toISOString().slice(0, 10);
}
function clampDay(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.min(day, lastDay);
}

// For a given bill and a given Fri-Thu week (given its Friday), returns the ISO date it
// lands on that week, or null if it doesn't occur that week at all.
function occurrenceInWeek(bill, friday) {
  if (bill.frequency === "weekly") {
    return dateToISO(addDays(friday, bill.weekday ?? 0));
  }
  if (bill.frequency === "biweekly") {
    const anchorFriday = weekStart(bill.anchor);
    const weeksDiff = Math.round((friday - anchorFriday) / (7 * 86400000));
    const phase = ((weeksDiff % 2) + 2) % 2;
    return phase === 0 ? dateToISO(addDays(friday, bill.weekday ?? 0)) : null;
  }
  // monthly — Fri..Thu spans two calendar months at most, so just scan all 7 days.
  for (let i = 0; i < 7; i++) {
    const d = addDays(friday, i);
    if (d.getDate() === clampDay(d.getFullYear(), d.getMonth(), bill.day || 1)) return dateToISO(d);
  }
  return null;
}

function isCleared(dateStr) {
  return dateStr <= todayISO();
}

let otherItems = []; // manual one-off transactions [{id, description, amount, type, date}]
let startingBalance = DEFAULT_STARTING_BALANCE;
let trackingStart = todayISO();
// Bills that landed early (or late) this one time — e.g. autopay processed before the usual
// date. Keyed by "<bill name>|<week Friday ISO>", doesn't change the recurring schedule itself.
let clearedEarlySet = new Set();
let unsubTxns = null;
let unsubMeta = null;
let unsubCleared = null;
let chart = null;
let visibleWeeksCount = WEEKS_VISIBLE_DEFAULT;
let showAllColumns = false;

// ---------- Gate / auth ----------

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
  unsubMeta = onSnapshot(
    doc(db, "meta", "settings"),
    async (snap) => {
      if (!snap.exists()) {
        try {
          await setDoc(doc(db, "meta", "settings"), {
            startingBalance: DEFAULT_STARTING_BALANCE,
            trackingStart: todayISO(),
          });
        } catch (e) {
          showToast("Couldn't initialize settings: " + e.message);
        }
        return;
      }
      const data = snap.data();
      startingBalance = Number(data.startingBalance ?? DEFAULT_STARTING_BALANCE);
      trackingStart = data.trackingStart || todayISO();
      $("#starting-balance").value = startingBalance;
      render();
    },
    (err) => showToast("Sync error: " + err.message)
  );

  unsubTxns = onSnapshot(
    query(collection(db, "transactions"), orderBy("date")),
    (snap) => {
      // Earlier testing (before bills were hardcoded) auto-generated real transaction docs
      // per recurring instance, each tagged with a categoryId. Those are stale leftovers —
      // only docs with no categoryId are genuine manual one-off entries.
      otherItems = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !t.categoryId);
      render();
    },
    (err) => showToast("Sync error: " + err.message)
  );

  unsubCleared = onSnapshot(
    collection(db, "clearedEarly"),
    (snap) => {
      clearedEarlySet = new Set(snap.docs.map((d) => d.id));
      render();
    },
    (err) => showToast("Sync error: " + err.message)
  );
}

function stopListeners() {
  if (unsubTxns) unsubTxns();
  if (unsubMeta) unsubMeta();
  if (unsubCleared) unsubCleared();
  otherItems = [];
  clearedEarlySet = new Set();
}

// Firestore only pushes updates when data changes, so a tab left open overnight would
// otherwise keep showing yesterday's Current Balance until something else triggers a
// re-render. Re-check whenever the tab regains focus, and poll while it's open so a bill
// due "today" drops off the balance right at midnight without needing a reload.
let lastRenderedDate = todayISO();
function recheckDate() {
  if (todayISO() !== lastRenderedDate) {
    lastRenderedDate = todayISO();
    render();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") recheckDate();
});
setInterval(recheckDate, 60000);

// ---------- Settings ----------

$("#show-more-weeks").addEventListener("click", () => {
  visibleWeeksCount = Math.min(visibleWeeksCount + WEEKS_VISIBLE_STEP, WEEKS_AHEAD + 1);
  render();
});

$("#toggle-columns-btn").addEventListener("click", () => {
  showAllColumns = !showAllColumns;
  render();
});

$("#settings-btn").addEventListener("click", () => $("#settings-modal").classList.remove("hidden"));
$("#settings-close").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
$("#settings-modal").addEventListener("click", (e) => {
  if (e.target.id === "settings-modal") $("#settings-modal").classList.add("hidden");
});

$("#settings-save").addEventListener("click", async () => {
  try {
    const sb = parseFloat($("#starting-balance").value) || 0;
    await setDoc(doc(db, "meta", "settings"), { startingBalance: sb, trackingStart: todayISO() }, { merge: true });
    $("#settings-modal").classList.add("hidden");
    showToast("Saved");
  } catch (e) {
    showToast("Save failed: " + e.message);
  }
});

// ---------- Add / manage one-off items ----------

let activeType = "expense";
function setActiveType(type) {
  activeType = type;
  document.querySelectorAll(".type-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
}
document.querySelectorAll(".type-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => setActiveType(btn.dataset.type));
});

$("#txn-date").value = todayISO();

$("#add-txn-btn").addEventListener("click", async () => {
  const desc = $("#txn-desc").value.trim();
  const amount = parseFloat($("#txn-amount").value);
  const date = $("#txn-date").value || todayISO();

  if (!desc) return showToast("Add a description");
  if (!amount || amount <= 0) return showToast("Enter an amount");

  try {
    await addDoc(collection(db, "transactions"), {
      description: desc,
      amount,
      type: activeType,
      date,
      createdAt: serverTimestamp(),
    });
    $("#txn-desc").value = "";
    $("#txn-amount").value = "";
    showToast("Added");
  } catch (e) {
    showToast("Couldn't add: " + e.message);
  }
});

$("#other-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.del;
  if (!id) return;
  try {
    await deleteDoc(doc(db, "transactions", id));
  } catch (e2) {
    showToast("Couldn't delete: " + e2.message);
  }
});

function renderOtherList() {
  const wrap = $("#other-list");
  const sorted = [...otherItems].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!sorted.length) {
    wrap.innerHTML = `<div class="empty-state">No one-off items yet.</div>`;
    return;
  }
  wrap.innerHTML = sorted
    .map((t) => {
      const sign = t.type === "income" ? "+" : "−";
      const dateLabel = new Date(t.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      return `
        <div class="other-row">
          <div class="other-main">
            <div class="other-desc">${escapeHtml(t.description)}</div>
            <div class="other-meta">${dateLabel}</div>
          </div>
          <div class="other-amount ${t.type}">${sign}${money(t.amount).replace("-", "")}</div>
          <button class="txn-del" data-del="${t.id}" title="Delete">✕</button>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------- Rendering ----------

const INCOME_CATS = RECURRING_BILLS.filter((c) => c.type === "income");
const EXPENSE_CATS = RECURRING_BILLS.filter((c) => c.type === "expense");

function fmtWeekRange(friday) {
  const thursday = addDays(friday, 6);
  const opts = { month: "short", day: "numeric" };
  return `${friday.toLocaleDateString(undefined, opts)} – ${thursday.toLocaleDateString(undefined, opts)}`;
}

// Builds the Friday-anchored week chain from trackingStart through `throughFriday`
// (inclusive), each with its bill breakdown and running balances. This is the single
// source of truth used by the table, the chart, and the current-balance calculation.
function computeWeeks(throughFriday) {
  const otherByWeek = new Map();
  otherItems.forEach((t) => {
    const key = dateToISO(weekStart(t.date));
    if (!otherByWeek.has(key)) otherByWeek.set(key, []);
    otherByWeek.get(key).push(t);
  });

  const weeks = [];
  let cur = weekStart(trackingStart);
  let runningEndOfWeekBalance = null; // previous week's end-of-week balance
  let isFirstWeek = true;

  while (cur <= throughFriday) {
    const friday = new Date(cur); // stable per-iteration binding — `cur` itself mutates below
    const key = dateToISO(friday);
    const weekOthers = otherByWeek.get(key) || [];
    const otherIncome = weekOthers.filter((t) => t.type === "income");
    const otherExpense = weekOthers.filter((t) => t.type === "expense");

    const catAmount = (cat) => (occurrenceInWeek(cat, friday) ? cat.amount : null);

    const incomeTotal =
      INCOME_CATS.reduce((s, c) => s + (catAmount(c) || 0), 0) + otherIncome.reduce((s, t) => s + t.amount, 0);
    const totalBills =
      EXPENSE_CATS.reduce((s, c) => s + (catAmount(c) || 0), 0) + otherExpense.reduce((s, t) => s + t.amount, 0);

    // startingBalance is the balance as of trackingStart's Friday, with that Friday's own
    // deposit already landed — so the first week's start balance IS startingBalance, not
    // startingBalance + that week's income (which would double-count the deposit).
    const weekStartBalance = isFirstWeek ? startingBalance : runningEndOfWeekBalance + incomeTotal;
    const endOfWeekBalance = weekStartBalance - totalBills;
    runningEndOfWeekBalance = endOfWeekBalance;
    isFirstWeek = false;

    weeks.push({
      friday,
      key,
      catAmount,
      otherIncome,
      otherExpense,
      incomeTotal,
      totalBills,
      weekStartBalance,
      endOfWeekBalance,
    });

    cur = addDays(cur, 7);
  }

  return weeks;
}

// The real, right-now balance. Unlike the table's projected chain (which assumes everything
// clears on schedule), this only counts an item once it's actually happened — except manual
// entries typed inline, which count the moment they're entered (see `immediate` flag below).
function computeCurrentBalance(weeks, todayISOStr) {
  let balance = startingBalance;
  weeks.forEach((w) => {
    INCOME_CATS.forEach((cat) => {
      const date = occurrenceInWeek(cat, w.friday);
      const clearedEarly = clearedEarlySet.has(clearedEarlyKey(cat.name, w.key));
      if (date && (date <= todayISOStr || clearedEarly)) balance += cat.amount;
    });
    EXPENSE_CATS.forEach((cat) => {
      const date = occurrenceInWeek(cat, w.friday);
      const clearedEarly = clearedEarlySet.has(clearedEarlyKey(cat.name, w.key));
      if (date && (date <= todayISOStr || clearedEarly)) balance -= cat.amount;
    });
    w.otherIncome.forEach((t) => {
      if (t.immediate || t.date <= todayISOStr) balance += t.amount;
    });
    w.otherExpense.forEach((t) => {
      if (t.immediate || t.date <= todayISOStr) balance -= t.amount;
    });
  });
  return balance;
}

function render() {
  lastRenderedDate = todayISO();
  const todayFriday = weekStart(todayISO());
  const todayISOStr = todayISO();
  const weeks = computeWeeks(addDays(todayFriday, 7 * WEEKS_AHEAD));
  const currentWeek = weeks.find((w) => w.key === dateToISO(todayFriday));

  $("#current-balance").textContent = money(computeCurrentBalance(weeks, todayISOStr));

  renderTable(weeks, todayFriday);
  renderOtherList();
}

function renderTable(weeks, todayFriday) {
  const todayWeekKey = dateToISO(todayFriday);

  // By default only show bill columns that actually occur this week; "Show all bills"
  // reveals every column, even ones with nothing due in the visible weeks.
  const activeIncomeCats = showAllColumns
    ? INCOME_CATS
    : INCOME_CATS.filter((c) => occurrenceInWeek(c, todayFriday));
  const activeExpenseCats = showAllColumns
    ? EXPENSE_CATS
    : EXPENSE_CATS.filter((c) => occurrenceInWeek(c, todayFriday));

  const toggleBtn = $("#toggle-columns-btn");
  toggleBtn.textContent = showAllColumns ? "Show only this week's bills" : "Show all bills";

  const thead = $("#ledger-thead");
  thead.innerHTML = `
    <tr>
      <th>Week of</th>
      ${activeIncomeCats.map((c) => `<th class="col-income">${escapeAttr(c.name)}</th>`).join("")}
      <th class="col-income">Extra</th>
      <th>Week start balance</th>
      ${activeExpenseCats.map((c) => `<th class="col-expense">${escapeAttr(c.name)}</th>`).join("")}
      <th class="col-expense">Other</th>
      <th>Total bills</th>
      <th>End of week</th>
    </tr>
  `;

  const tbody = $("#ledger-tbody");
  tbody.innerHTML = "";
  let thisWeekIn = 0, thisWeekOut = 0, thisWeekEow = null, thisWeekStartBalance = startingBalance;

  // Stats always look at the full computed range (the current week is always in it), even
  // though the table itself only renders a slice.
  const currentWeekData = weeks.find((w) => w.key === todayWeekKey);
  if (currentWeekData) {
    thisWeekIn = currentWeekData.incomeTotal;
    thisWeekOut = currentWeekData.totalBills;
    thisWeekEow = currentWeekData.endOfWeekBalance;
    thisWeekStartBalance = currentWeekData.weekStartBalance;
  }

  const visibleWeeks = weeks.slice(0, visibleWeeksCount);
  const moreBtn = $("#show-more-weeks");
  const remaining = weeks.length - visibleWeeks.length;
  moreBtn.classList.toggle("hidden", remaining <= 0);
  moreBtn.textContent = `Show ${Math.min(WEEKS_VISIBLE_STEP, remaining)} more weeks`;

  visibleWeeks.forEach((w) => {
    const tr = document.createElement("tr");
    if (w.key === todayWeekKey) tr.className = "row-current";

    const cells = [];
    cells.push(`<td class="cell-date">${fmtWeekRange(w.friday)}${w.key === todayWeekKey ? '<span class="cell-sub">this week</span>' : ""}</td>`);

    activeIncomeCats.forEach((cat) => {
      cells.push(billCellHtml(cat, w));
    });
    cells.push(otherCellHtml(w.otherIncome, "income", w.key));

    cells.push(`<td class="cell-computed">${money(w.weekStartBalance)}</td>`);

    activeExpenseCats.forEach((cat) => {
      cells.push(billCellHtml(cat, w));
    });
    cells.push(otherCellHtml(w.otherExpense, "expense", w.key));

    cells.push(`<td class="cell-computed">${money(w.totalBills)}</td>`);
    cells.push(`<td class="cell-computed ${w.endOfWeekBalance < 0 ? "negative" : ""}">${money(w.endOfWeekBalance)}</td>`);

    tr.innerHTML = cells.join("");
    tbody.appendChild(tr);
  });

  $("#week-in").textContent = money(thisWeekIn);
  $("#week-out").textContent = money(thisWeekOut);
  $("#week-projected").textContent = money(thisWeekEow ?? thisWeekStartBalance);

  wireOtherCellInputs();
  renderChart(weeks);
}

// Fixed bill cells aren't editable, but are clickable to flag a one-time early/late clearing
// (e.g. autopay processed before the usual date) without changing the recurring schedule.
function billCellHtml(cat, w) {
  const amt = w.catAmount(cat);
  if (!amt) return `<td>–</td>`;
  const clearedEarly = clearedEarlySet.has(clearedEarlyKey(cat.name, w.key));
  const title = clearedEarly
    ? "Marked as already cleared early — click to undo"
    : "Click if this already cleared your bank early";
  return `<td class="cell-bill${clearedEarly ? " cleared-early" : ""}" data-kind="bill" data-bill="${escapeAttr(cat.name)}" data-week="${w.key}" title="${title}">${money(amt)}</td>`;
}

// Renders the Extra / Other cell: a single editable inline input when there's 0 or 1 manual
// item for that week + type, or a read-only sum (with a tooltip) when there's more than one —
// in that case, edit/remove the individual items in "Add a one-off item" below instead.
function otherCellHtml(items, type, weekKey) {
  const cls = type === "income" ? "income-cell" : "expense-cell";
  if (items.length <= 1) {
    const val = items[0]?.amount ?? "";
    return `<td><input type="number" step="0.01" class="cell-input ${cls}" data-kind="other" data-other-type="${type}" data-week="${weekKey}" value="${val}" placeholder="–" /></td>`;
  }
  const sum = items.reduce((s, t) => s + t.amount, 0);
  return `<td class="cell-computed" title="${items.length} manual entries this week — edit them below">${money(sum)}</td>`;
}

function wireOtherCellInputs() {
  document.querySelectorAll('#ledger-table input[data-kind="other"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      upsertOtherCell(e.target.dataset.week, e.target.dataset.otherType, e.target.value);
    });
  });
  document.querySelectorAll('#ledger-table td[data-kind="bill"]').forEach((cell) => {
    cell.addEventListener("click", (e) => {
      toggleClearedEarly(e.currentTarget.dataset.bill, e.currentTarget.dataset.week);
    });
  });
}

async function upsertOtherCell(weekKey, type, amountStr) {
  const amount = parseFloat(amountStr);
  const matches = otherItems.filter((t) => t.type === type && dateToISO(weekStart(t.date)) === weekKey);
  try {
    if (!amount || amount <= 0) {
      await Promise.all(matches.map((t) => deleteDoc(doc(db, "transactions", t.id))));
      return;
    }
    if (matches.length === 1) {
      // Editing inline counts it immediately, regardless of the entry's original date.
      await updateDoc(doc(db, "transactions", matches[0].id), { amount, immediate: true });
    } else if (matches.length === 0) {
      await addDoc(collection(db, "transactions"), {
        description: type === "income" ? "Extra income" : "Other",
        amount,
        type,
        date: weekKey, // lands on that week's Friday
        immediate: true,
        createdAt: serverTimestamp(),
      });
    }
  } catch (e) {
    showToast("Couldn't save: " + e.message);
  }
}

function clearedEarlyKey(billName, weekKey) {
  return `${billName}|${weekKey}`;
}

async function toggleClearedEarly(billName, weekKey) {
  const key = clearedEarlyKey(billName, weekKey);
  try {
    if (clearedEarlySet.has(key)) {
      await deleteDoc(doc(db, "clearedEarly", key));
    } else {
      await setDoc(doc(db, "clearedEarly", key), { billName, weekKey, markedAt: serverTimestamp() });
    }
  } catch (e) {
    showToast("Couldn't update: " + e.message);
  }
}

function renderChart(weeks) {
  const ctx = document.getElementById("balance-chart");
  const points = weeks.map((w) => w.endOfWeekBalance);
  const labels = weeks.map((w) => w.friday.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }));

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = points;
    chart.update();
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: points,
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
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}
