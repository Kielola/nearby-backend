import * as admin from 'firebase-admin';

// We do NOT initialize this at app boot. If we did, the whole backend
// would refuse to start in local dev before you've filled in real
// Firebase credentials. Instead we initialize on the FIRST actual
// verification attempt — boot stays fast and doesn't depend on secrets
// it doesn't need yet.
let app: admin.app.App | null = null;

export function getFirebaseAuth(): admin.auth.Auth {
  if (!app) {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Env vars can't hold real newlines, so Firebase private keys
        // get stored with literal "\n" text — this swaps them back to
        // actual newline characters, which the key parser requires.
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.auth();
}
