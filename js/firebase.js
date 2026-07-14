// Firebase Firestore signup submission.
//
// Loaded via full CDN ES module URLs (not bare specifiers) — no bundler and
// no import map entry needed, since browsers resolve absolute URL imports
// natively. Analytics is intentionally not imported.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// PASTE YOUR firebaseConfig HERE
const firebaseConfig = {
  apiKey: "AIzaSyDS1AvVhqXH8wVf2u-bUDzleh0_JOT44tM",
  authDomain: "monad-passpor.firebaseapp.com",
  projectId: "monad-passpor",
  storageBucket: "monad-passpor.firebasestorage.app",
  messagingSenderId: "242382231369",
  appId: "1:242382231369:web:481bab88828b2a3db22c98"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Writes one signup document to the 'signups' collection. Returns the
// addDoc() promise so callers can await it and catch failures themselves.
export function submitSignup(email, discord) {
  return addDoc(collection(db, "signups"), {
    email,
    discord,
    createdAt: serverTimestamp(),
  });
}
