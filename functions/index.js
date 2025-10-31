const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { CloudTasksClient } = require("@google-cloud/tasks");

// 基本はGCP_PROJECTが自動で補完される
const PROJECT_ID = process.env.GCP_PROJECT || process.env.PROJECT_ID;
const LOCATION = 'asia-northeast1';
const QUEUE_NAME = 'regular-execution';
const ENDPOINT_URL = 'https://regular-execution-push-9mu9.vercel.app/';
const SERVICE_ACCOUNT_EMAIL = 'cloud-tasks-sa@linebot-799ed.iam.gserviceaccount.com';

// Cloud Tasksクライアントの初期化
const client = new CloudTasksClient();

// Firebase Admin SDKの初期化
admin.initializeApp();
const db = admin.firestore();


exports.onUserSettingsUpdate = functions
  .firestore.document("users/{userId}/noticeSetting")
  .onUpdate(async (change, context) => {

    try {
      // ドキュメントパスの{userId}部分
      const userId = context.params.userId;

      // 更新前後のドキュメントデータ取得
      const before = change.before.data();
      const after = change.after.data();

      // 更新前後の時間と曜日情報を取得
      const newWeek = after.week;
      const newTime = after.time;
      const oldWeek = before.week;
      const oldTime = before.time;

      // 送信日時が変更されていたら、trueになっている
      if (after.nextNotice === false){
        return;
      }

      // 設定曜日数が0の時即時return
      if (!newWeek.includes(true)) return;

      // 古いタスクは削除
      if (before?.taskName){
        await deleteTaskIfExists(before.taskName);
      }

      // ====通知時刻の計算====
      let targetIso;
      const now = new Date(); // 現在の日時
      let target = new Date(now); // 編集用のコピー

      // 時間設定
      const [hh, mm] = newTime.split(":").map(Number);
      target.setHours(hh, mm, 0, 0);

      // 曜日設定
      // week: 配列[日, 月, 火, 水, 木, 金, 土]、trueなら通知
      const today = now.getDay();
      let minDiff = 7; // 次回までの日数差を初期化

      for (let i = 0; i < 7; i++) {
        if (!newWeek[i]) continue; // 通知対象でなければスキップ

        let diff = i - today;
        if (diff < 0) diff += 7; // 過去曜日なら翌週に回す

        if (diff === 0 && target <= now) {
          diff = 7; // 今日の通知時間が過ぎていたら次週に
        }

        if (diff < minDiff) minDiff = diff; // 最も近い通知日を選ぶ
      }

      target.setDate(target.getDate() + minDiff); // 日付を補正
      targetIso = target.toISOString();
      // =========

      // CloudTasksに登録するタスクデータ
      const parent = client.queuePath(PROJECT_ID, LOCATION, QUEUE_NAME);
      const payload = { userId };
      const task = {
        scheduleTime: {
          seconds: Math.floor(new Date(targetIso).getTime() / 1000),
        },
        httpRequest: {
          httpMethod: "POST",
          url: ENDPOINT_URL,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(payload)).toString("base64"),
          oidcToken: { serviceAccountEmail: SERVICE_ACCOUNT_EMAIL },
        },
      };

      // タスク作成
      const [response] = await client.createTask({ parent, task });

      // Firestore Update
      await db.doc(`users/${userId}/noticeSetting`).update({
        taskName: response.name,
        nextNotice: false,
      });

      console.log(`Task created for ${userId}: ${response.name}`);
    }catch (e){
      console.log(e);
    }
  });


// タスク削除用関数
async function deleteTaskIfExists(taskName){
  try{
    await client.deleteTask({ name: taskName });
    console.log("Deleted task:", taskName);
  }catch (e){
    console.log("Delete task failed:", e.message);
  }
}