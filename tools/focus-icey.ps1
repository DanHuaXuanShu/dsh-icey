<#
  把 ICEY 窗口抢到前台，并可顺带按一个键。
  背景：DSH 的 pwsh 在自己的进程里跑，SetForegroundWindow 会被前台锁拦下，
  必须 AttachThreadInput 到当前前台线程才能改。ICEY 是 Unity，只在收到真实
  SendInput/keybd_event 时才认键，PostMessage 它不看。

  用法：
    pwsh -File tools\focus-icey.ps1              # 只抢前台，报告结果
    pwsh -File tools\focus-icey.ps1 -Key space   # 抢前台后按空格
    pwsh -File tools\focus-icey.ps1 -Key enter -KeyDelay 300
#>
param(
  [string]$Key = "",
  [int]$KeyDelay = 250,
  [int]$Tries = 6,
  [int]$HoldMs = 0
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static string Title(IntPtr h) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);          // SW_RESTORE
    IntPtr fg = GetForegroundWindow();
    uint fgProc = 0;
    uint fgThread = (fg == IntPtr.Zero) ? 0 : GetWindowThreadProcessId(fg, out fgProc);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) {
      attached = AttachThreadInput(myThread, fgThread, true);
    }
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    return GetForegroundWindow() == h;
  }
}
"@

$proc = Get-Process -Name ICEY -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output "NO_ICEY_PROCESS"; exit 2 }
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_ICEY_WINDOW pid=$($proc.Id)"; exit 3 }

$ok = $false
for ($i = 0; $i -lt $Tries; $i++) {
  if ([Win]::Focus($hwnd)) { $ok = $true; break }
  Start-Sleep -Milliseconds 200
}
$fg = [Win]::GetForegroundWindow()
Write-Output ("hwnd={0} pid={1} focused={2} fg=0x{3:X} fgTitle={4}" -f $hwnd, $proc.Id, $ok, $fg.ToInt64(), [Win]::Title($fg))
if (-not $ok) { Write-Output "FOCUS_FAILED"; exit 4 }

if ($Key -ne "") {
  $map = @{
    space = 0x20; enter = 0x0D; esc = 0x1B; tab = 0x09
    j = 0x4A; i = 0x49; l = 0x4C; u = 0x55; o = 0x4F
    w = 0x57; a = 0x41; s = 0x53; d = 0x44
    up = 0x26; down = 0x28; left = 0x25; right = 0x27
  }
  $vk = $map[$Key.ToLower()]
  if ($null -eq $vk) { Write-Output "UNKNOWN_KEY $Key"; exit 5 }
  Start-Sleep -Milliseconds $KeyDelay
  [Win]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  if ($HoldMs -gt 0) {
    Start-Sleep -Milliseconds $HoldMs
  } else {
    Start-Sleep -Milliseconds 90
  }
  [Win]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  Write-Output "KEY_SENT $Key 0x$("{0:X}" -f $vk) hold=${HoldMs}"
}
