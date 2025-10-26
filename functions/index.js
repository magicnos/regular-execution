const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { CloudTasksClient } = require("@google-cloud/tasks");

admin.initializeApp();
const db = admin.firestore();

const PROJECT_ID = process.env.GCP_PROJECT || process.env.PROJECT_ID;
const LOCATION = "asia-northeast1";
const QUEUE_NAME = "notify-queue";
const ENDPOINT_URL = process.env.PUSH_ENDPOINT_URL;
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;

const client = new CloudTasksClient();

exports.onUserSettingsUpdate = onDocumentWritten(
  "users/{userId}/noticeSetting",
  async (event) => {
    const userId = event.params.userId;
    const after = event.data?.after?.data();
    const before = event.data?.before?.data();

    // ドキュメント削除時
    if (!after) {
      if (before?.notification?.taskName) {
        await deleteTaskIfExists(before.notification.taskName);
      }
      return;
    }

    const newNotif = after.notification;
    const oldNotif = before?.notification;

    // 時間設定が削除された場合
    if (!newNotif?.time) {
      if (oldNotif?.taskName) {
        await deleteTaskIfExists(oldNotif.taskName);
        await db.doc(`users/${userId}/noticeSetting`).update({
          "notification.taskName": admin.firestore.FieldValue.delete(),
        });
      }
      return;
    }

    // timeが変わっていない場合
    if (
      oldNotif &&
      oldNotif.time === newNotif.time &&
      oldNotif.timezone === newNotif.timezone &&
      oldNotif.taskName
    ) {
      console.log("time not changed - skip scheduling");
      return;
    }

    // 旧タスク削除
    if (oldNotif?.taskName) {
      await deleteTaskIfExists(oldNotif.taskName);
    }

    // 次回通知時刻を計算
    let targetIso;
    if (newNotif.nextOccurrenceIso) {
      targetIso = newNotif.nextOccurrenceIso;
    } else {
      const now = new Date();
      const [hh, mm] = newNotif.time.split(":").map(Number);
      let target = new Date(now);
      target.setHours(hh, mm, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      targetIso = target.toISOString();
    }

    // Cloud Tasks タスク作成
    const parent = client.queuePath(PROJECT_ID, LOCATION, QUEUE_NAME);
    const payload = { userId };

    const task = {
      scheduleTime: { seconds: Math.floor(new Date(targetIso).getTime() / 1000) },
      httpRequest: {
        httpMethod: "POST",
        url: ENDPOINT_URL,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        oidcToken: { serviceAccountEmail: SERVICE_ACCOUNT_EMAIL },
      },
    };

    const [response] = await client.createTask({ parent, task });
    console.log("Created task:", response.name);

    await db.doc(`users/${userId}/noticeSetting`).update({
      "notification.taskName": response.name,
    });
  }
);

async function deleteTaskIfExists(taskName) {
  try {
    await client.deleteTask({ name: taskName });
    console.log("Deleted task:", taskName);
  } catch (e) {
    console.log("Delete task failed:", e.message);
  }
}
