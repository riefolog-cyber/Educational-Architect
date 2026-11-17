import { initializeApp, getApp, getApps, FirebaseApp } from "firebase/app";
import { getAuth, Auth, GoogleAuthProvider } from "firebase/auth";
import { getDatabase, Database } from "firebase/database";
import { getFirestore, Firestore, doc, getDocFromServer } from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Database | null = null;
let dbFirestore: Firestore | null = null;
let googleProvider: GoogleAuthProvider | null = null;

try {
  if (getApps().length === 0) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApp();
  }
  
  auth = getAuth(app);
  if ((firebaseConfig as any).databaseURL) {
    db = getDatabase(app);
  }
  if (firebaseConfig.firestoreDatabaseId) {
    dbFirestore = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  } else {
    dbFirestore = getFirestore(app);
  }
  googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({
    prompt: "select_account"
  });
} catch (error) {
  console.error("Firebase failing to initialize. App will run in Sandbox mode.", error);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function buildFirestoreErrorInfo(error: unknown, operationType: OperationType, path: string | null): FirestoreErrorInfo {
  return {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
}

export function reportFirestoreError(error: unknown, operationType: OperationType, path: string | null): FirestoreErrorInfo {
  const errInfo = buildFirestoreErrorInfo(error, operationType, path);
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = reportFirestoreError(error, operationType, path);
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<boolean> {
  if (!dbFirestore) return false;
  try {
    await getDocFromServer(doc(dbFirestore, "active_sessions", "__connection_probe__"));
    return true;
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg.includes("the client is offline") || err?.code === "unavailable") {
      console.warn("Controlla la configurazione Firebase o la connessione di rete: Firestore risulta offline.");
      return false;
    }
    return true;
  }
}

if (typeof window !== "undefined") {
  void testConnection();
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const currentUser = auth?.currentUser;
    if (!currentUser) return {};
    const token = await currentUser.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (err) {
    console.warn("Impossibile ottenere token auth Firebase:", err);
    return {};
  }
}

export { app, auth, db, dbFirestore, googleProvider };
export { firebaseConfig };
