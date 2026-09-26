// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
require("./compileCache.cjs");
// The personal fork has its own data and updater boundary. Never let a
// packaged Switch build take over the stock app's live database or updater.
if (require("electron").app.getVersion().includes("-switch.")) {
  process.env.T3CODE_HOME ??= require("node:path").join(require("node:os").homedir(), ".t3-switch");
  process.env.T3CODE_DISABLE_AUTO_UPDATE = "true";
}
require("./main.cjs");
