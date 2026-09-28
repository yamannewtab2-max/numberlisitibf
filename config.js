// ── Setup ────────────────────────────────────────────────────────────────
// Leave this file empty and the app still works: numbers are stored on the phone
// (localStorage) and the WhatsApp message comes from Gemini via /api/message.
//
// Fill in the Firebase block to keep the same list in the cloud (Firestore).
// Get it from: Firebase console → Project settings → Your apps → Web app → Config.
//
// Two console steps after pasting:
//   1. Firestore Database → Create database.
//   2. Authentication → Sign-in method → Anonymous → Enable.
//      (The app signs in silently; there is no login screen and no password.)
//
// Then set these Firestore rules:
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /categories/{doc} { allow read, write: if request.auth != null; }
//       match /businesses/{doc} { allow read, write: if request.auth != null; }
//     }
//   }
window.APP_CONFIG = {
  firebase: {
    apiKey: "AIzaSyCZnj-YaoAI4TRIpa8uuSmefQDZWY450XE",
    authDomain: "numberlisting-22048.firebaseapp.com",
    projectId: "numberlisting-22048",
    appId: "1:677833840240:web:b57df58776950cc33f46b5"
  }
};
