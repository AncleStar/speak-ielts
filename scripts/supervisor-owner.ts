import childProcess from "node:child_process";
/** Windows kill(pid, 0) may return EPERM for a missing process. Confirm the unique launch instance. */
export function supervisorLockAlive(old: { pid: number; instance: string }) {
  if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || !/^[\w-]+$/.test(old.instance ?? "")) throw new Error("旧启动锁格式无效，无法确认所属进程。");
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${old.pid}'; if ($null -eq $p) {'absent'} elseif (-not $p.CommandLine) {'unknown'} elseif ($p.CommandLine.Contains('scripts/dev-all.ts') -and $p.CommandLine.Contains('--instance=${old.instance}')) {'owned'} else {'other'}`;
    const result = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
    if (result === "unknown" || !["owned", "absent", "other"].includes(result)) throw new Error("无法确认旧启动进程，未替换启动锁。请检查本机进程权限。");
    return result === "owned";
  }
  try { process.kill(old.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
