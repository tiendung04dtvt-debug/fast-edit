import fs from 'node:fs';

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Cập nhật thanh segmented tabs 3 nút
const oldTabs = `<div class="editor-segmented-tabs" style="grid-template-columns:1fr 1fr">
            <button type="button" id="tabBtnCut" class="editor-tab-pill active cutjoin" onclick="switchWorkflowGroup('cut')" style="font-size:13px;font-weight:800;padding:10px">
              ✂️ 1. Cắt Video & Nâng Chất Lượng
            </button>
            <button type="button" id="tabBtnJoin" class="editor-tab-pill effects" onclick="switchWorkflowGroup('join')" style="font-size:13px;font-weight:800;padding:10px">
              🎞️ 2. Ghép Nhiều Video (Timeline)
            </button>
          </div>`;

const newTabs = `<div class="editor-segmented-tabs" style="grid-template-columns:1fr 1fr 1.15fr">
            <button type="button" id="tabBtnCut" class="editor-tab-pill active cutjoin" onclick="switchWorkflowGroup('cut')" style="font-size:12px;font-weight:800;padding:9px 4px">
              ✂️ 1. Cắt Video
            </button>
            <button type="button" id="tabBtnJoin" class="editor-tab-pill effects" onclick="switchWorkflowGroup('join')" style="font-size:12px;font-weight:800;padding:9px 4px">
              🎞️ 2. Ghép Video
            </button>
            <button type="button" id="tabBtnBeauty" class="editor-tab-pill beauty" onclick="switchWorkflowGroup('beauty')" style="font-size:12px;font-weight:800;padding:9px 4px;color:#7c3aed">
              ✨ 3. Làm Đẹp & Đổi Nền
            </button>
          </div>`;

if (html.includes(oldTabs)) {
  html = html.replace(oldTabs, newTabs);
  console.log("Segmented tabs updated to 3 buttons.");
} else {
  console.log("Old tabs not found via strict match, attempting normalize...");
  html = html.replace(
    /<div class="editor-segmented-tabs" style="grid-template-columns:1fr 1fr">[\s\S]*?<\/div>/,
    newTabs
  );
}

// 2. Thêm beautySubModeBox ngay sau joinSubModeBox
const targetJoinClose = `              </div>
            </div>
          </div>

          <!-- KHUNG HIỂN THỊ KẾT QUẢ XỬ LÝ`;

const beautyBoxHtml = `              </div>
            </div>

            <!-- CHẾ ĐỘ 1C: LÀM ĐẸP & ĐỔI PHÔNG NỀN (AI MATTING & SHARPEN) -->
            <div id="beautySubModeBox" style="display:none;flex-direction:column;gap:12px;min-width:0;max-width:100%;box-sizing:border-box">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                  <h4 style="margin:0;font-size:13.5px;font-weight:800;color:#7c3aed">
                    ✨ Làm Đẹp Video & Đổi Phông Nền
                  </h4>
                  <div style="font-size:11px;color:var(--muted);margin-top:2px">
                    Khử mờ camera, làm sáng da, xóa phông hoặc đổi nền lớp học (không cần phông xanh).
                  </div>
                </div>
                <span class="badge purple">AI Matting & CAS</span>
              </div>

              <!-- KHỐI 1: LÀM NÉT & SÁNG DA -->
              <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px">
                <div style="font-size:12px;font-weight:800;color:#6b21a8;display:flex;align-items:center;gap:6px">
                  <span>💎 1. Khử mờ & Sáng da tự nhiên</span>
                </div>

                <!-- Thanh trượt Sắc nét -->
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:11.5px;font-weight:700;color:#334155;margin-bottom:3px">
                    <span>🔍 Độ sắc nét (Khử mờ tóc, mắt, chữ viết slide/bảng):</span>
                    <span id="labelSharpenVal" style="color:#7c3aed;font-weight:800">50%</span>
                  </div>
                  <input type="range" id="sliderSharpen" min="0" max="100" value="50" oninput="updateBeautyControls()" style="width:100%;accent-color:#7c3aed;cursor:pointer">
                  <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8">
                    <span>0% (Gốc)</span>
                    <span>50% (Đẹp tự nhiên)</span>
                    <span>100% (Rất nét)</span>
                  </div>
                </div>

                <!-- Thanh trượt Sáng da -->
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:11.5px;font-weight:700;color:#334155;margin-bottom:3px">
                    <span>🌸 Làm sáng & Tươi tắn khuôn mặt:</span>
                    <span id="labelBeautyVal" style="color:#7c3aed;font-weight:800">30%</span>
                  </div>
                  <input type="range" id="sliderBeauty" min="0" max="100" value="30" oninput="updateBeautyControls()" style="width:100%;accent-color:#7c3aed;cursor:pointer">
                  <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8">
                    <span>0% (Tự nhiên)</span>
                    <span>30% (Trắng hồng)</span>
                    <span>100% (Sáng bừng)</span>
                  </div>
                </div>
              </div>

              <!-- KHỐI 2: PHÔNG NỀN PHÍA SAU -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px">
                <div style="font-size:12px;font-weight:800;color:#1e293b;display:flex;align-items:center;justify-content:space-between">
                  <span>🖼️ 2. Đổi phông nền phía sau (Chống méo hình 100%)</span>
                  <span style="font-size:10px;color:#059669;font-weight:700;background:#ecfdf5;padding:2px 6px;border-radius:4px;border:1px solid #a7f3d0">✓ Khóa tỉ lệ chuẩn</span>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                  <label class="bg-option-card active" id="bgCardOriginal" onclick="selectBgOption('original')" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:2px solid #7c3aed;background:#fff;border-radius:8px;cursor:pointer">
                    <input type="radio" name="bgChoice" value="original" checked style="accent-color:#7c3aed">
                    <div style="font-size:11.5px;font-weight:700;color:#1e293b">🏠 Nền gốc</div>
                  </label>

                  <label class="bg-option-card" id="bgCardBlur" onclick="selectBgOption('blur')" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer">
                    <input type="radio" name="bgChoice" value="blur" style="accent-color:#7c3aed">
                    <div style="font-size:11.5px;font-weight:700;color:#1e293b">📷 Xóa mờ phông</div>
                  </label>

                  <label class="bg-option-card" id="bgCardClassroom" onclick="selectBgOption('classroom')" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer">
                    <input type="radio" name="bgChoice" value="classroom" style="accent-color:#7c3aed">
                    <div style="font-size:11.5px;font-weight:700;color:#1e293b">🏫 Lớp học bảng đen</div>
                  </label>

                  <label class="bg-option-card" id="bgCardBookshelf" onclick="selectBgOption('bookshelf')" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer">
                    <input type="radio" name="bgChoice" value="bookshelf" style="accent-color:#7c3aed">
                    <div style="font-size:11.5px;font-weight:700;color:#1e293b">📚 Kệ sách ấm cúng</div>
                  </label>
                </div>

                <!-- Tải ảnh nền riêng -->
                <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
                  <input type="file" id="customBgFileInput" accept="image/*" style="display:none" onchange="handleCustomBgUpload(event)">
                  <button type="button" class="btn outline" onclick="$('#customBgFileInput').click()" style="flex:1;font-size:11.5px;font-weight:700;padding:6px 12px;border-color:#cbd5e1;background:#fff;color:#334155;border-radius:6px">
                    📁 Tự tải ảnh nền từ máy bạn...
                  </button>
                  <span id="customBgFileName" style="font-size:11px;color:#64748b;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
                </div>

                <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:6px 10px;font-size:10.5px;color:#065f46;display:flex;align-items:center;gap:6px">
                  <span>🛡️</span>
                  <span><b>Chống méo hình thông minh:</b> Người giữ 100% tỉ lệ gốc, ảnh nền tự căn giữa không bị dẹt/kéo dài.</span>
                </div>
              </div>

              <!-- NÚT THAO TÁC -->
              <div style="display:flex;gap:10px;margin-top:4px">
                <button type="button" id="btnPreviewBeauty" class="btn outline" onclick="toggleBeautyPreview()" style="flex:1;font-size:12px;font-weight:800;padding:9px;border-color:#7c3aed;color:#7c3aed;border-radius:8px;background:#fff">
                  👁️ Xem trước hiệu ứng
                </button>
                <button type="button" id="btnExportBeauty" class="btn primary" onclick="exportBeautyVideo()" style="flex:1.2;font-size:12px;font-weight:800;padding:9px;background:linear-gradient(135deg, #7c3aed, #4f46e5);border:none;border-radius:8px;color:#fff;box-shadow:0 4px 12px rgba(124, 58, 237, 0.3)">
                  ⚡ Xuất video đã làm đẹp
                </button>
              </div>

              <!-- TIẾN ĐỘ XUẤT VIDEO LÀM ĐẸP -->
              <div id="beautyProgressBox" class="task-progress-box" style="display:none">
                <div class="task-progress-top">
                  <span class="task-progress-label">
                    <span class="spinner" style="width:13px;height:13px;border-width:2px;border-top-color:#7c3aed"></span>
                    Đang khử mờ & làm đẹp đa luồng CPU siêu tốc...
                  </span>
                  <span class="task-progress-pct" style="color:#7c3aed;background:#faf5ff;border-color:#e9d5ff">50%</span>
                </div>
                <div class="task-progress-track">
                  <div class="task-progress-fill" style="width:70%;background:linear-gradient(90deg,#a855f7,#7c3aed)"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- KHUNG HIỂN THỊ KẾT QUẢ XỬ LÝ`;

if (html.includes(targetJoinClose)) {
  html = html.replace(targetJoinClose, beautyBoxHtml);
  console.log("beautySubModeBox injected successfully.");
} else {
  console.log("Target join close not found via strict match, attempting regex...");
  html = html.replace(
    /(<div id="joinSubModeBox"[\s\S]*?<\/div>\s*<\/div>)\s*(<!-- KHUNG HIỂN THỊ KẾT QUẢ)/,
    `$1\n${beautyBoxHtml.slice(beautyBoxHtml.indexOf('<!-- CHẾ ĐỘ 1C:'))}\n$2`
  );
}

fs.writeFileSync('public/index.html', html, 'utf8');
console.log("public/index.html updated successfully!");
