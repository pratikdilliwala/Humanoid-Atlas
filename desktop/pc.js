// Windows helpers: PowerShell, installed apps, media keys, wallpaper, theme, the foreground-window watcher and wallpaper colour.
const { execFile, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { nativeImage } = require('electron');

const enc = s => Buffer.from(s, 'utf16le').toString('base64');
function ps(script, timeout = 20000){
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(script)],
      { timeout, windowsHide: true, maxBuffer: 4*1024*1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim(), timedOut: !!(err && err.killed) }));
  });
}
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

// every app in the Start menu (desktop and Store apps), cached for ten minutes
let appsCache = null, appsT = 0;
async function startApps(){
  if (appsCache && Date.now() - appsT < 600000) return appsCache;
  const r = await ps('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress');
  try { appsCache = [].concat(JSON.parse(r.out || '[]')); appsT = Date.now(); } catch (e) { appsCache = appsCache || []; }
  return appsCache;
}
async function findApp(name){
  const n = String(name).toLowerCase().trim(), apps = await startApps();
  const score = a => { const x = a.Name.toLowerCase(); return x === n ? 4 : x.startsWith(n) ? 3 : x.split(/\s+/).includes(n) ? 2.5 : x.includes(n) ? 2 : n.split(/\s+/).every(w => x.includes(w)) ? 1 : 0; };
  // shortest name wins a tie, so "Spotify" beats "Spotify Uninstaller"
  return apps.map(a => [score(a), a]).filter(x => x[0]).sort((a, b) => b[0] - a[0] || a[1].Name.length - b[1].Name.length).map(x => x[1])[0] || null;
}
function launchApp(appId){ spawn('explorer.exe', ['shell:AppsFolder\\' + appId], { detached: true, stdio: 'ignore' }).unref(); }

const KEYS = { play_pause: 179, next: 176, previous: 177, stop: 178, mute: 173, volume_down: 174, volume_up: 175 };
const sendKeys = (code, times = 1) => ps(`$w = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${code}) }`);
async function setVolume(pct){
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  // each key step is 2%: go to zero, then climb
  await sendKeys(KEYS.volume_down, 50);
  if (pct) await sendKeys(KEYS.volume_up, Math.round(pct/2));
}

function setWallpaper(file){
  return ps(`Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WP { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d); }'
[void][WP]::SystemParametersInfo(20, 0, ${q(file)}, 3)`);
}
function setTheme(mode){
  const v = mode === 'light' ? 1 : 0, k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
  return ps(`Set-ItemProperty -Path ${q(k)} -Name AppsUseLightTheme -Value ${v}; Set-ItemProperty -Path ${q(k)} -Name SystemUsesLightTheme -Value ${v}`);
}

// the window you're working in, every 30 seconds, from one long-running PowerShell
const WATCH = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
while ($true) {
  $h = [FG]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512
  [void][FG]::GetWindowText($h, $sb, 512); [uint32]$p = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$p)
  $n = ''; $d = ''; try { $pr = Get-Process -Id $p -ErrorAction Stop; $n = $pr.ProcessName; $d = $pr.MainModule.FileVersionInfo.FileDescription } catch {}
  [Console]::Out.WriteLine((@{ proc = $n; desc = $d; title = $sb.ToString() } | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  Start-Sleep -Seconds 30
}`;
function watchForeground(onSample){
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(WATCH)], { windowsHide: true });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0){ const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); try { onSample(JSON.parse(line)); } catch (e) {} }
  });
  return child;
}

// the most vivid colour in the wallpaper, as 0..1 RGB
function wallpaperFile(){
  return ps(`(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper`).then(r => {
    let f = r.out;
    if (!f || !fs.existsSync(f)){
      const t = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
      f = fs.existsSync(t) ? t : '';
    }
    return f;
  });
}
function accentOf(file){
  let img;
  try {
    // TranscodedWallpaper has no extension, so read it as a buffer
    img = nativeImage.createFromBuffer(fs.readFileSync(file));
  } catch (e) { return null; }
  if (img.isEmpty()) return null;
  const small = img.resize({ width: 64 }), { width, height } = small.getSize(), px = small.toBitmap();
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < width*height; i++){
    const b = px[i*4]/255, g = px[i*4+1]/255, r = px[i*4+2]/255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn)/mx : 0;
    if (s < 0.2 || mx < 0.15) continue;
    let h = mx === r ? (g - b)/(mx - mn) : mx === g ? 2 + (b - r)/(mx - mn) : 4 + (r - g)/(mx - mn);
    h = ((h*60) + 360) % 360;
    const bin = bins[Math.floor(h/30)], w = s*mx;
    bin.w += w; bin.r += r*w; bin.g += g*w; bin.b += b*w;
  }
  const best = bins.reduce((a, b) => b.w > a.w ? b : a);
  if (best.w < 1) return null;
  let r = best.r/best.w, g = best.g/best.w, b = best.b/best.w;
  // push it to a bright, saturated neon of the same hue
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = c => mn + (c - mn)*1.6;
  r = sat(r); g = sat(g); b = sat(b);
  const m2 = Math.max(r, g, b, 1e-3);
  return [r/m2, g/m2, b/m2].map(c => Math.max(0, Math.min(1, c)));
}

function userFolders(){
  const h = os.homedir();
  const list = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'].map(f => path.join(h, f));
  for (const f of fs.readdirSync(h).filter(x => /^OneDrive/i.test(x))){ list.push(path.join(h, f)); }
  return list.filter(f => { try { return fs.statSync(f).isDirectory(); } catch (e) { return false; } });
}

module.exports = { ps, q, startApps, findApp, launchApp, KEYS, sendKeys, setVolume, setWallpaper, setTheme, watchForeground, wallpaperFile, accentOf, userFolders };
