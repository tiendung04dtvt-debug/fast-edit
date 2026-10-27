import fs from 'node:fs';

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Thêm khối Lọc tạp âm & Tiếng quạt vào giao diện Cắt phân đoạn
const oldCutBox = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px">
                <span style="font-size:16px">⚡</span>
                <div>
                  <div style="font-size:11.5px;font-weight:700;color:#166534">Chế độ Cắt Siêu Tốc (Lossless 100% Gốc)</div>
                  <div style="font-size:10.5px;color:#15803d">Chỉ mất 0.5s - 1s · Giữ nguyên vẹn độ nét và chất lượng gốc, không nén lại</div>
                </div>
              </div>

              <button type="button" class="btn primary" id="btnRunSmartCut" onclick="runSmartCut()" style="width:100%;background:#2563eb;box-shadow:0 3px 12px rgba(37,99,235,0.25);padding:10px;font-size:13px;font-weight:800">
                🚀 Cắt phân đoạn ngay
              </button>`;

const newCutBox = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px">
                <span style="font-size:16px">⚡</span>
                <div>
                  <div style="font-size:11.5px;font-weight:700;color:#166534">Chế độ Cắt Siêu Tốc (Lossless 100% Gốc)</div>
                  <div style="font-size:10.5px;color:#15803d">Chỉ mất 0.5s - 1s · Giữ nguyên vẹn độ nét và chất lượng gốc, không nén lại</div>
                </div>
              </div>

              <!-- TÙY CHỌN LỌC SẠCH TẠP ÂM / TIẾNG QUẠT / TIẾNG GIÓ -->
              <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:6px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin:0">
                  <input type="checkbox" id="chkDenoiseAudio" style="width:16px;height:16px;accent-color:#0d9488;cursor:pointer">
                  <div>
                    <div style="font-size:12px;font-weight:800;color:#0f766e;display:flex;align-items:center;gap:5px">
                      <span>🎙️ Lọc sạch tạp âm & Tiếng quạt, gió</span>
                      <span class="badge" style="font-size:9.5px;padding:1px 6px;background:#ccfbf1;color:#0f766e;border-color:#5eead4">Khử ồn thông minh</span>
                    </div>
                    <div style="font-size:10.5px;color:#115e59">Tự động loại bỏ tiếng ù quạt trần, gió rít, tiếng rè rè micro · Giọng nói trong vắt và ấm</div>
                  </div>
                </label>
              </div>

              <div style="display:flex;gap:8px">
                <button type="button" class="btn primary" id="btnRunSmartCut" onclick="runSmartCut()" style="flex:1.4;background:#2563eb;box-shadow:0 3px 12px rgba(37,99,235,0.25);padding:10px;font-size:13px;font-weight:800">
                  🚀 Cắt phân đoạn ngay
                </button>
                <button type="button" class="btn outline" id="btnQuickDenoise" onclick="runQuickDenoise()" style="flex:1;background:#fff;border-color:#0d9488;color:#0f766e;font-size:11.5px;font-weight:800;padding:10px 8px;display:flex;align-items:center;justify-content:center;gap:4px" title="Lọc sạch tiếng quạt và tạp âm cho toàn bộ video này mà không cần cắt">
                  <span>🎙️ Lọc ồn cả video (1s)</span>
                </button>
              </div>`;

if (html.includes(oldCutBox)) {
  html = html.replace(oldCutBox, newCutBox);
  console.log("Denoise controls added to Smart Cut box.");
} else {
  console.log("Old cut box not matched strictly, attempting regex...");
  html = html.replace(
    /(<div style="background:#f0fdf4[\s\S]*?<\/div>\s*<\/div>)\s*(<button type="button" class="btn primary" id="btnRunSmartCut"[\s\S]*?<\/button>)/,
    newCutBox
  );
}

// 2. Cập nhật runSmartCut để truyền param denoise
const oldRunSmartCut = `    const res = await api('/api/video/smart-cut', {
      projectId: project.id,
      videoName: currentEditorVideo.name,
      start: inVal,
      end: outVal,
      lossless: true
    }, { signal: task.signal });`;

const newRunSmartCut = `    const enableDenoise = $('#chkDenoiseAudio')?.checked || false;
    const res = await api('/api/video/smart-cut', {
      projectId: project.id,
      videoName: currentEditorVideo.name,
      start: inVal,
      end: outVal,
      lossless: true,
      denoise: enableDenoise
    }, { signal: task.signal });`;

if (html.includes(oldRunSmartCut)) {
  html = html.replace(oldRunSmartCut, newRunSmartCut);
  console.log("runSmartCut updated with denoise parameter.");
}

// 3. Thêm hàm runQuickDenoise vào cuối script
const denoiseScript = `
// --- TÍNH NĂNG 1-CLICK LỌC SẠCH TẠP ÂM & TIẾNG QUẠT, GIÓ ---
async function runQuickDenoise() {
  if (!project || !currentEditorVideo) {
    toast('Vui lòng chọn hoặc tải một video trước khi lọc tạp âm.');
    return;
  }
  const btn = $('#btnQuickDenoise');
  if (btn) btn.disabled = true;
  pauseAllEditorPlayers();

  const task = startEditorTask('Lọc sạch tạp âm & Tiếng quạt', () => {
    if (btn) btn.disabled = false;
  }, {
    boxId: 'smartCutProgressBox',
    steps: [
      '🎙️ Đang phân tích âm thanh & phát hiện tiếng quạt...',
      '⚡ Đang khử ồn đa luồng & giữ 100% video gốc...',
      '✓ Xuất video hoàn chỉnh...'
    ],
    estSeconds: 1.5
  });

  try {
    const res = await api('/api/video/denoise', {
      projectId: project.id,
      videoName: currentEditorVideo.name
    }, { signal: task.signal });

    displayEditorResult(
      '🎙️ Lọc sạch tạp âm & Tiếng quạt thành công!',
      \`Tập tin: \${res.fileName} · Video gốc giữ nguyên 100% · Giọng nói trong vắt · Xử lý xong trong \${(res.processTimeMs/1000).toFixed(1)}s!\`,
      \`media/\${res.fileName}\`,
      res.fileName,
      res.duration
    );
    toast(\`🎉 Đã lọc sạch tiếng ồn chỉ trong \${(res.processTimeMs/1000).toFixed(1)}s!\`, 5000);
    refreshVideoLibrarySilently();
  } catch (err) {
    if (err.name !== 'AbortError') {
      alert('Lỗi lọc tạp âm: ' + err.message);
    }
  } finally {
    task.done();
    if (btn) btn.disabled = false;
  }
}
`;

const lastScriptTag = html.lastIndexOf('</script>');
html = html.slice(0, lastScriptTag) + '\n' + denoiseScript + '\n' + html.slice(lastScriptTag);

fs.writeFileSync('public/index.html', html, 'utf8');
console.log("public/index.html successfully updated with Denoise features!");
