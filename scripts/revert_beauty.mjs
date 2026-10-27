import fs from 'node:fs';

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Trả lại 2 tab chuẩn gọn gàng
const tabs2 = `<div class="editor-segmented-tabs" style="grid-template-columns:1fr 1fr">
            <button type="button" id="tabBtnCut" class="editor-tab-pill active cutjoin" onclick="switchWorkflowGroup('cut')" style="font-size:13px;font-weight:800;padding:10px">
              ✂️ 1. Cắt Video & Nâng Chất Lượng
            </button>
            <button type="button" id="tabBtnJoin" class="editor-tab-pill effects" onclick="switchWorkflowGroup('join')" style="font-size:13px;font-weight:800;padding:10px">
              🎞️ 2. Ghép Nhiều Video (Timeline)
            </button>
          </div>`;

html = html.replace(
  /<div class="editor-segmented-tabs"[\s\S]*?<\/div>/,
  tabs2
);

// 2. Xóa beautySubModeBox
html = html.replace(
  /<!-- CHẾ ĐỘ 1C: LÀM ĐẸP[\s\S]*?<\/div>\s*<\/div>\s*(?=<!-- KHUNG HIỂN THỊ KẾT QUẢ)/,
  ''
);

// 3. Trả lại switchWorkflowGroup về 2 nhóm
const cleanSwitch = `function switchWorkflowGroup(group) {
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

html = html.replace(
  /function switchWorkflowGroup\(group\) \{[\s\S]*?if \(group === 'beauty'\) updateBeautyControls\(\);\s*\}/,
  cleanSwitch
);

// 4. Xóa đoạn script beauty thừa
html = html.replace(
  /\/\/ --- BỘ CÔNG CỤ LÀM ĐẸP & ĐỔI PHÔNG NỀN[\s\S]*?exportBeautyVideo[\s\S]*?progressBox\.style\.display = 'none';\s*\}\s*\}/,
  ''
);

fs.writeFileSync('public/index.html', html, 'utf8');
console.log("Reverted beauty feature cleanly.");
