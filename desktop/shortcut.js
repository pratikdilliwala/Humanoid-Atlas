// Adds Atlas to the desktop and Start menu, launched through Electron's own signed runtime.
// Use this where Windows Smart App Control blocks the unsigned installer. Run: npm run shortcut
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const electron = require('electron'); // from plain Node this is the path to electron.exe

// an .ico that wraps the PNG (Windows Vista and later read PNG-in-ICO)
const png = fs.readFileSync(path.join(__dirname, 'icon.png'));
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
const ico = path.join(__dirname, 'icon.ico');
fs.writeFileSync(ico, Buffer.concat([head, png]));

const q = s => "'" + s.replace(/'/g, "''") + "'";
const script = `$w = New-Object -ComObject WScript.Shell
foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $s = $w.CreateShortcut((Join-Path $d 'Atlas.lnk'))
  $s.TargetPath = ${q(electron)}; $s.Arguments = '"' + ${q(__dirname)} + '"'; $s.WorkingDirectory = ${q(__dirname)}
  $s.IconLocation = ${q(ico)}; $s.Description = 'Atlas, the humanoid made of light'; $s.Save()
  Write-Output (Join-Path $d 'Atlas.lnk')
}`;
const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]).toString();
console.log('Created:\n' + out.trim());
