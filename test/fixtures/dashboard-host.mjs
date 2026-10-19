import { createDashboardServer } from "../../src/dashboard.ts";
import { installExitCleanup } from "../../src/procs.ts";

installExitCleanup(false);
const server = createDashboardServer();
server.listen(0, "127.0.0.1", () => process.send(server.address().port));
// Emit inside the child so signal-handler tests also work on Windows.
process.on("message", signal => signal === "exit" ? process.exit(0) : process.emit(signal));
