// Fill this in with your own Firebase project's config.
// Get it from: Firebase Console → Project settings → General → "Your apps" → SDK setup and configuration.
// This config is safe to commit publicly — it is not a secret. Your data is protected by
// Firestore security rules + email/password auth (see README.md), not by hiding this file.
export const firebaseConfig = {
  apiKey: "AIzaSyCCVZZYieGNz6IfrrKI-duyC4SioK21Iqw",
  authDomain: "budgeteer-33ef7.firebaseapp.com",
  projectId: "budgeteer-33ef7",
  storageBucket: "budgeteer-33ef7.firebasestorage.app",
  messagingSenderId: "907727365601",
  appId: "1:907727365601:web:b529828e50e072ba2bdea0"
};

// The shared login email for the household account created in Firebase Authentication.
// See README.md step 3 — this is just a username, it does not need to be a real inbox.
export const SHARED_EMAIL = "household@budgeteer.local";

// Prefix mixed into the 5-digit passcode before it's sent to Firebase Auth as a password
// (Firebase requires 6+ character passwords, so we pad a 5-digit PIN with this).
// Change it to anything if you want, just keep it consistent.
export const PASSCODE_SALT = "bg-";

