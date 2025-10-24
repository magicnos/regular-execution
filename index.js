const { onUpdateHandler } = require("./tasks/createTask");
const { pushHandler } = require("./tasks/pushHandler");

exports.onUpdateFirestore = onUpdateHandler;
exports.sendMessage = pushHandler;
