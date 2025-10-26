const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {CloudTasksClient} = require("@google-cloud/tasks");

admin.initializeApp();
const db = admin.firestore();

const PROJECT_ID = process.env.GCP_PROJECT || process.env.PROJECT_ID;
const LOCATION = "asia-northeast1";
const QUEUE_NAME = "notify-queue";
const ENDPOINT_URL = process.env.PUSH_ENDPOINT_URL; // 例: https://.../push (Cloud Function HTTP or Vercel)
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL; // 作成したSA

const client = new CloudTasksClient();

function nextOccurrenceFromHHMM(hhmm, timezone) {
  // hhmm: "07:30", timezone: "Asia/Tokyo"
  // returns JS Date object (milliseconds) in UTC representing next occurrence (今日または明日)
  const [hh, mm] = hhmm.split(":").map(Number);
  // Use ICU-supported timezone: create Date for now in timezone via toLocaleString trick
  const now = new Date();
  // Construct date string in the target timezone by using Date components via toLocaleString
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(now);

  const getPart = (type) => parts.find(p => p.type === type).value;
  let Y = Number(getPart("year")), M = Number(getPart("month")), D = Number(getPart("day"));
  // build candidate date in timezone:
  let candidate = new Date(Date.UTC(Y, M - 1, D, hh, mm, 0));
  // But candidate above is UTC of that Y/M/D hh:mm => adjust: the created Date should represent hh:mm in the timezone.
  // Simpler approach: compute target as Date from locale string
  const localeStr = `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`;
  // Create Date by interpreting it in timezone: use Date built from locale with options not trivial in pure JS.
  // So instead: use luxon or rely on simple heuristic: schedule for today at hh:mm based on timezone offset difference.
  // For simplicity and reliability in cloud functions, prefer storing absolute timestamp in client. For now:
  return { iso: `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00${getTimezoneOffsetString(timezone, now)}` };
}

function getTimezoneOffsetString(timezone, now) {
  // Try to compute offset like +09:00 for given timezone at 'now'
  const tzDate = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMinutes = (now.getTime() - tzDate.getTime()) / (60*1000);
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(Math.round(offsetMinutes));
  const hh = String(Math.floor(abs/60)).padStart(2,"0");
  const mm = String(abs%60).padStart(2,"0");
  return `${sign}${hh}:${mm}`;
}

exports.onUserSettingsUpdate = functions.firestore
  .document("users/{userId}")
  .onWrite(async (change, context) => {
    const userId = context.params.userId;
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;

    if (!after) {
      // deleted user: try delete existing task if any
      if (before && before.notification && before.notification.taskName) {
        await deleteTaskIfExists(before.notification.taskName);
      }
      return null;
    }

    const newNotif = after.notification;
    const oldNotif = before ? before.notification : null;

    // if no notification configured, maybe cancel previous
    if (!newNotif || !newNotif.time) {
      if (oldNotif && oldNotif.taskName) {
        await deleteTaskIfExists(oldNotif.taskName);
        await change.after.ref.update({ "notification.taskName": admin.firestore.FieldValue.delete() });
      }
      return null;
    }

    // If time not changed and taskName exists, do nothing
    if (oldNotif && oldNotif.time === newNotif.time && oldNotif.timezone === newNotif.timezone && oldNotif.taskName) {
      console.log("time not changed - skip scheduling");
      return null;
    }

    // Delete old task if exists
    if (oldNotif && oldNotif.taskName) {
      await deleteTaskIfExists(oldNotif.taskName);
    }

    // Compute target time (best: client should send ISO timestamp for next occurrence. 
    // For simplicity here assume client gave 'nextOccurrenceIso' or we compute naive next-day)
    let targetIso;
    if (newNotif.nextOccurrenceIso) {
      targetIso = newNotif.nextOccurrenceIso; // preferred: client provides exact ISO with timezone
    } else {
      // fallback: schedule for today or tomorrow at hh:mm in given timezone
      const hhmm = newNotif.time;
      const tz = newNotif.timezone || "Asia/Tokyo";
      // For reliability in production use a timezone library (luxon). Here, we assume next day simple approach:
      const now = new Date();
      const [hh, mm] = hhmm.split(":").map(Number);
      let target = new Date(now);
      target.setHours(hh, mm, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      targetIso = target.toISOString();
    }

    const parent = client.queuePath(PROJECT_ID, LOCATION, QUEUE_NAME);
    const payload = { userId };

    const task = {
      scheduleTime: { seconds: Math.floor(new Date(targetIso).getTime() / 1000) },
      httpRequest: {
        httpMethod: "POST",
        url: ENDPOINT_URL,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        oidcToken: {
          // Cloud Tasks will attach an OIDC token; the receiving endpoint must verify it or allow that SA
          serviceAccountEmail: SERVICE_ACCOUNT_EMAIL
        }
      }
    };

    const [response] = await client.createTask({ parent, task });
    console.log("Created task:", response.name);

    // Save taskName back to user's doc so we can delete later when user changes settings
    await change.after.ref.update({ "notification.taskName": response.name });

    return null;
  });

async function deleteTaskIfExists(taskName) {
  try {
    await client.deleteTask({ name: taskName });
    console.log("Deleted task:", taskName);
  } catch (e) {
    console.log("Delete task failed (maybe already executed):", e.message);
  }
}
