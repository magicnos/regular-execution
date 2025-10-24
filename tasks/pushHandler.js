const functions = require("firebase-functions");
const admin = require("firebase-admin");
const line = require("@line/bot-sdk");

const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_TOKEN });

exports.pushHandler = functions.runWith({ memory: "256MB", timeoutSeconds: 30 })
  .https.onRequest(async (req, res) => {
    // Cloud Tasks が送る OIDC トークンで認証されているか確認したい場合は検証を追加
    try {
      const { userId } = req.body;
      if (!userId) {
        res.status(400).send("no userId");
        return;
      }

      // 送信内容は要件に合わせてカスタム
      const message = { type: "text", text: "設定した時間になりました！" };

      await client.pushMessage(userId, message);

      // (オプション) 再スケジューリング（毎日繰り返しにする場合）
      // ここで Firestore のユーザー doc を読み、次回分の task を作る実装を追加できます

      res.status(200).send("ok");
    } catch (e) {
      console.error(e);
      res.status(500).send("error");
    }
  });
