// tasks/createTask.js から Firestoreトリガー関数を読み込む
const { onUpdateHandler } = require("./tasks/createTask");

// tasks/pushHandler.js から HTTP関数を読み込む
const { pushHandler } = require("./tasks/pushHandler");

// Firestore更新トリガー関数
exports.onUpdateFirestore = onUpdateHandler;

// HTTP関数（Push エンドポイント）
exports.sendMessage = (req, res) => {
  pushHandler(req.body)
    .then(result => res.status(200).send(result))
    .catch(err => res.status(500).send(err.message));
};
