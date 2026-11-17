import net from "node:net";
import { spawn } from "node:child_process";

// Docker's internal networks may not publish ports on Docker Desktop. Tunnel
// HTTP through docker exec in the existing database container instead. Neither
// container has an external route and no additional image is needed.
export async function localPostgrestProxy({ container, apiName }) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(apiName)) throw new Error("invalid_test_container");
  const sockets = new Set();
  const children = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const child = spawn("docker", ["exec", "-i", container, "bash", "-c",
      `exec 3<>/dev/tcp/${apiName}/3000; cat <&3 & cat >&3`], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stderr.resume();
    child.stdin.on("error", () => socket.destroy());
    child.on("error", () => socket.destroy());
    child.on("close", () => { children.delete(child); socket.destroy(); });
    socket.on("error", () => child.kill());
    socket.on("close", () => { sockets.delete(socket); child.stdin.end(); child.kill(); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
