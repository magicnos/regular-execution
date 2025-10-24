// Push関数を読み込む
const { pushHandler } = require("./tasks/pushHandler");

// HTTPトリガー関数としてエクスポート
exports.sendMessage = (req, res) => {
  pushHandler(req.body)                  // pushHandler は Promise を返す想定
    .then(result => res.status(200).send(result))
    .catch(err => res.status(500).send(err.message));
};