import fs from 'node:fs';

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Cập nhật switchWorkflowGroup để hỗ trợ 'beauty'
const oldSwitch = `function switchWorkflowGroup(group) {
  const btnCut = $('#tabBtnCut');
  const btnJoin = $('#tabBtnJoin');
  const boxCut = $('#cutSubModeBox');
  const boxJoin = $('#joinSubModeBox');

  if (group === 'cut') {
    if (btnCut) btnCut.className = 'editor-tab-pill active cutjoin';
    if (btnJoin) btnJoin.className = 'editor-tab-pill effects';
    if (boxCut) boxCut.style.display = 'flex';
    if (boxJoin) boxJoin.style.display = 'none';
  } else {
    if (btnCut) btnCut.className = 'editor-tab-pill cutjoin';
    if (btnJoin) btnJoin.className = 'editor-tab-pill active effects';
    if (boxCut) boxCut.style.display = 'none';
    if (boxJoin) boxJoin.style.display = 'flex';
    renderJoinerTrack();
  }
}`;

const newSwitch = `function switchWorkflowGroup(group) {
  const btnCut = $('#tabBtnCut');
  const btnJoin = $('#tabBtnJoin');
  const btnBeauty = $('#tabBtnBeauty');
  const boxCut = $('#cutSubModeBox');
  const boxJoin = $('#joinSubModeBox');
  const boxBeauty = $('#beautySubModeBox');

  if (btnCut) btnCut.className = 'editor-tab-pill cutjoin' + (group === 'cut' ? ' active' : '');
  if (btnJoin) btnJoin.className = 'editor-tab-pill effects' + (group === 'join' ? ' active' : '');
  if (btnBeauty) btnBeauty.className = 'editor-tab-pill beauty' + (group === 'beauty' ? ' active' : '');

  if (boxCut) boxCut.style.display = group === 'cut' ? 'flex' : 'none';
  if (boxJoin) boxJoin.style.display = group === 'join' ? 'flex' : 'none';
  if (boxBeauty) boxBeauty.style.display = group === 'beauty' ? 'flex' : 'none';

  if (group === 'join') renderJoinerTrack();
  if (group === 'beauty') updateBeautyControls();
}`;

if (html.includes(oldSwitch)) {
  html = html.replace(oldSwitch, newSwitch);
  console.log("switchWorkflowGroup replaced.");
} else {
  console.log("oldSwitch not found directly, replacing via regex...");
  html = html.replace(/function switchWorkflowGroup\(group\) \{[\s\S]*?renderJoinerTrack\(\);\s*\}\s*\}/, newSwitch);
}

// 2. Thêm logic làm đẹp vào cuối script
const beautyScript = `
// --- BỘ CÔNG CỤ LÀM ĐẸP & ĐỔI PHÔNG NỀN (BEAUTY & VIRTUAL BACKGROUND) ---
let currentBgChoice = 'original';
let customBgDataUrl = null;
let isBeautyPreviewActive = false;

function selectBgOption(choice) {
  currentBgChoice = choice;
  const cards = ['original', 'blur', 'classroom', 'bookshelf'];
  cards.forEach(c => {
    const card = document.getElementById('bgCard' + c.charAt(0).toUpperCase() + c.slice(1));
    if (card) {
      if (c === choice) {
        card.style.border = '2px solid #7c3aed';
        card.style.background = '#faf5ff';
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      } else {
        card.style.border = '1px solid #cbd5e1';
        card.style.background = '#fff';
      }
    }
  });
  if (isBeautyPreviewActive) applyLiveBeautyPreview();
}

function handleCustomBgUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    customBgDataUrl = evt.target.result;
    currentBgChoice = 'custom';
    const nameEl = document.getElementById('customBgFileName');
    if (nameEl) nameEl.textContent = '✓ ' + file.name;
    ['original', 'blur', 'classroom', 'bookshelf'].forEach(c => {
      const card = document.getElementById('bgCard' + c.charAt(0).toUpperCase() + c.slice(1));
      if (card) {
        card.style.border = '1px solid #cbd5e1';
        card.style.background = '#fff';
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = false;
      }
    });
    toast('📁 Đã chọn ảnh nền: ' + file.name);
    if (isBeautyPreviewActive) applyLiveBeautyPreview();
  };
  reader.readAsDataURL(file);
}

function updateBeautyControls() {
  const sSharpen = document.getElementById('sliderSharpen');
  const sBeauty = document.getElementById('sliderBeauty');
  const lSharpen = document.getElementById('labelSharpenVal');
  const lBeauty = document.getElementById('labelBeautyVal');

  if (sSharpen && lSharpen) lSharpen.textContent = sSharpen.value + '%';
  if (sBeauty && lBeauty) lBeauty.textContent = sBeauty.value + '%';

  if (isBeautyPreviewActive) applyLiveBeautyPreview();
}

function applyLiveBeautyPreview() {
  const player = document.getElementById('editorVideoPlayer');
  if (!player) return;
  const sharpen = Number(document.getElementById('sliderSharpen')?.value || 50);
  const beauty = Number(document.getElementById('sliderBeauty')?.value || 30);

  if (!isBeautyPreviewActive) {
    player.style.filter = 'none';
    removeBackgroundOverlay();
    return;
  }

  const brightness = 1.0 + (beauty / 100) * 0.08;
  const contrast = 1.0 + (sharpen / 100) * 0.08;
  const saturate = 1.0 + (beauty / 100) * 0.15;
  player.style.filter = \`brightness(\${brightness.toFixed(2)}) contrast(\${contrast.toFixed(2)}) saturate(\${saturate.toFixed(2)})\`;

  if (currentBgChoice === 'original') {
    removeBackgroundOverlay();
  } else {
    showBackgroundNotice(currentBgChoice);
  }
}

function removeBackgroundOverlay() {
  const badge = document.getElementById('beautyPreviewNotice');
  if (badge) badge.remove();
}

function showBackgroundNotice(mode) {
  let notice = document.getElementById('beautyPreviewNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'beautyPreviewNotice';
    notice.style.position = 'absolute';
    notice.style.top = '12px';
    notice.style.left = '12px';
    notice.style.background = 'rgba(15, 23, 42, 0.88)';
    notice.style.color = '#fff';
    notice.style.padding = '6px 14px';
    notice.style.borderRadius = '20px';
    notice.style.fontSize = '11.5px';
    notice.style.fontWeight = '700';
    notice.style.backdropFilter = 'blur(6px)';
    notice.style.zIndex = '10';
    notice.style.border = '1px solid rgba(255,255,255,0.25)';
    notice.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    const container = document.getElementById('editorVideoPlayer')?.parentElement;
    if (container) {
      container.style.position = 'relative';
      container.appendChild(notice);
    }
  }
  let modeName = 'Nền gốc';
  if (mode === 'blur') modeName = '📷 Xóa mờ phông Studio';
  else if (mode === 'classroom') modeName = '🏫 Lớp học bảng đen';
  else if (mode === 'bookshelf') modeName = '📚 Kệ sách ấm cúng';
  else if (mode === 'custom') modeName = '🖼️ Ảnh nền tùy chọn';

  notice.innerHTML = \`✨ Đang xem trước: <b>\${modeName}</b> · Nét: <b>\${document.getElementById('sliderSharpen')?.value || 50}%</b> · Sáng da: <b>\${document.getElementById('sliderBeauty')?.value || 30}%</b>\`;
}

function toggleBeautyPreview() {
  isBeautyPreviewActive = !isBeautyPreviewActive;
  const btn = document.getElementById('btnPreviewBeauty');
  if (btn) {
    if (isBeautyPreviewActive) {
      btn.style.background = '#7c3aed';
      btn.style.color = '#ffffff';
      btn.textContent = '✕ Tắt xem trước';
      toast('👁️ Đã bật Xem trước hiệu ứng làm đẹp trực tiếp!');
    } else {
      btn.style.background = '#fff';
      btn.style.color = '#7c3aed';
      btn.textContent = '👁️ Xem trước hiệu ứng';
      toast('Đã tắt xem trước.');
    }
  }
  applyLiveBeautyPreview();
}

async function exportBeautyVideo() {
  if (!project || !activeVideo) {
    alert('Vui lòng chọn hoặc tải một video trước khi làm đẹp.');
    return;
  }
  const sharpen = Number(document.getElementById('sliderSharpen')?.value || 50);
  const beauty = Number(document.getElementById('sliderBeauty')?.value || 30);
  const progressBox = document.getElementById('beautyProgressBox');
  const btnExport = document.getElementById('btnExportBeauty');

  if (btnExport) btnExport.disabled = true;
  if (progressBox) progressBox.style.display = 'block';

  toast('⏳ Đang khử mờ & làm đẹp video bằng thuật toán CPU đa luồng siêu tốc...', 12000);

  try {
    const res = await fetch('/api/video/beauty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        videoName: activeVideo.name,
        sharpen,
        beauty,
        bgMode: currentBgChoice
      })
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Lỗi làm đẹp video: ' + (data.error || 'Thao tác thất bại'));
      return;
    }
    toast(\`🎉 Làm đẹp video thành công chỉ trong \${(data.processTimeMs / 1000).toFixed(1)}s!\`, 5000);

    const resultBox = document.getElementById('editorResultBox');
    const resultTitle = document.getElementById('editorResultTitle');
    const resultSub = document.getElementById('editorResultSub');
    const resultPlayer = document.getElementById('editorResultPlayer');
    const resultDownload = document.getElementById('btnResultDownload');

    if (resultTitle) resultTitle.textContent = '✨ Video đã được làm nét & làm đẹp hoàn hảo!';
    if (resultSub) resultSub.textContent = \`Tập tin: \${data.fileName} · Độ nét: \${sharpen}% · Sáng da: \${beauty}% · Xử lý xong trong \${(data.processTimeMs/1000).toFixed(1)}s\`;
    if (resultPlayer) {
      resultPlayer.src = data.downloadUrl;
      resultPlayer.load();
    }
    if (resultDownload) {
      resultDownload.onclick = () => downloadVideoToCustomFolder(data.downloadUrl, data.fileName);
    }
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.scrollIntoView({ behavior: 'smooth' });
    }
    refreshVideoLibrarySilently();
  } catch (err) {
    alert('Lỗi khi xuất video: ' + err.message);
  } finally {
    if (btnExport) btnExport.disabled = false;
    if (progressBox) progressBox.style.display = 'none';
  }
}
`;

const lastScriptTag = html.lastIndexOf('</script>');
html = html.slice(0, lastScriptTag) + '\n' + beautyScript + '\n' + html.slice(lastScriptTag);

fs.writeFileSync('public/index.html', html, 'utf8');
console.log("Beauty logic successfully injected into public/index.html!");
