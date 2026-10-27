import fs from 'node:fs';

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Thêm nút Cập nhật vào Header
const headerTarget = '🔒 100% Cục bộ & Bảo mật\n    </span>';
const headerTargetCRLF = '🔒 100% Cục bộ & Bảo mật\r\n    </span>';

const buttonHtml = `
    <button id="btnAppUpdate" onclick="handleUpdateClick()" title="Kiểm tra & Cập nhật phiên bản mới nhất từ GitHub" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;padding:5px 12px;background:#f8fafc;color:#334155;border:1px solid #cbd5e1;border-radius:20px;cursor:pointer;transition:all 0.2s">
      <span id="updateIcon">🔄</span>
      <span id="updateLabel">Bản v1.0.0</span>
    </button>`;

if (html.includes(headerTargetCRLF)) {
  html = html.replace(headerTargetCRLF, headerTargetCRLF + buttonHtml);
} else if (html.includes(headerTarget)) {
  html = html.replace(headerTarget, headerTarget + buttonHtml);
} else {
  console.error("Header target not found!");
}

// 2. Thêm logic cập nhật vào cuối script
const scriptCode = `
// --- AUTO-UPDATE QUA GITHUB ---
let latestUpdateInfo = null;

async function checkAppUpdate(isManual = false) {
  const btn = document.getElementById('btnAppUpdate');
  const icon = document.getElementById('updateIcon');
  const label = document.getElementById('updateLabel');
  if (isManual) {
    if (label) label.textContent = 'Đang kiểm tra...';
    if (icon) icon.textContent = '⏳';
  }
  try {
    const res = await fetch('/api/update/check');
    const data = await res.json();
    if (!data.ok) {
      if (isManual) alert(data.error || 'Không thể kiểm tra cập nhật lúc này');
      if (label) label.textContent = 'Bản v' + (data.localVersion || '1.0.0');
      if (icon) icon.textContent = '🔄';
      return;
    }
    latestUpdateInfo = data;
    if (label) label.textContent = 'Bản v' + data.localVersion;
    if (icon) icon.textContent = '🔄';

    if (data.hasUpdate) {
      if (btn) {
        btn.style.background = 'linear-gradient(135deg, #7c3aed, #4f46e5)';
        btn.style.color = '#ffffff';
        btn.style.border = '1px solid #6366f1';
        btn.style.boxShadow = '0 0 14px rgba(124, 58, 237, 0.45)';
      }
      if (icon) icon.textContent = '🚀';
      if (label) label.textContent = 'Có bản mới v' + data.remoteVersion + '!';

      if (!isManual) {
        toast('🚀 Đã có bản cập nhật mới v' + data.remoteVersion + '! Bấm nút [Có bản mới] ở góc trên để nâng cấp trong 2 giây.', 9000);
      }
    } else {
      if (isManual) {
        alert('Bạn đang dùng phiên bản mới nhất (v' + data.localVersion + ')!');
      }
    }
  } catch (err) {
    if (isManual) alert('Lỗi kết nối kiểm tra cập nhật: ' + err.message);
    if (label) label.textContent = 'Bản v1.0.0';
    if (icon) icon.textContent = '🔄';
  }
}

async function handleUpdateClick() {
  if (!latestUpdateInfo || !latestUpdateInfo.hasUpdate) {
    await checkAppUpdate(true);
    if (!latestUpdateInfo || !latestUpdateInfo.hasUpdate) return;
  }
  
  const notes = latestUpdateInfo.notes ? ('\\n\\nNội dung mới:\\n' + latestUpdateInfo.notes) : '';
  const confirmUpdate = confirm('🎉 Đã có phiên bản mới v' + latestUpdateInfo.remoteVersion + '!' + notes + '\\n\\nBạn có muốn cập nhật ngay bây giờ không?\\n(Dung lượng siêu nhẹ ~300 KB, tải xong app sẽ tự làm mới trong 2 giây)');
  if (!confirmUpdate) return;

  const btn = document.getElementById('btnAppUpdate');
  const label = document.getElementById('updateLabel');
  const icon = document.getElementById('updateIcon');
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Đang nâng cấp...';
  if (icon) icon.textContent = '⏳';
  toast('⏳ Đang tải bản cập nhật mới nhất từ GitHub...', 10000);

  try {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      alert('Lỗi cập nhật: ' + (data.error || 'Thao tác thất bại'));
      if (btn) btn.disabled = false;
      if (label) label.textContent = 'Thử lại';
      return;
    }
    toast('✅ ' + data.message + ' Đang tự động làm mới giao diện...', 3000);
    setTimeout(() => {
      window.location.reload();
    }, 1200);
  } catch (err) {
    alert('Lỗi khi nâng cấp: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

setTimeout(() => {
  checkAppUpdate(false);
}, 3000);
`;

const endScript = '</script>';
if (html.includes(endScript)) {
  const lastIdx = html.lastIndexOf(endScript);
  html = html.slice(0, lastIdx) + scriptCode + '\n' + html.slice(lastIdx);
  fs.writeFileSync('public/index.html', html, 'utf8');
  console.log("Successfully injected updater into public/index.html");
} else {
  console.error("End script tag not found!");
}
