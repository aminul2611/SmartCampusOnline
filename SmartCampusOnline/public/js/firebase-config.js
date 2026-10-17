import { initializeApp } from
    "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import { getAuth } from
    "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { getFirestore } from
    "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDrqvItpxtIriQw-xjRjjhRZLVDHysWqIo",
    authDomain: "smart-campus-9aafa.firebaseapp.com",
    projectId: "smart-campus-9aafa",
    storageBucket: "smart-campus-9aafa.firebasestorage.app",
    messagingSenderId: "664487521483",
    appId: "1:664487521483:web:a86c58184073890036bf4e"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };