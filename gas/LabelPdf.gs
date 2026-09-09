/**
 * LabelPdf.gs - 箱ラベル（QR＋商品名）の PDF 生成
 *
 * admin/qr-generator.html の印刷ページと同じ用紙・寸法（エーワン 31266、A4縦 8面）を
 * Google Slides 上に pt 単位で再現し、PDF として書き出します。
 *
 *   buildLabelPdf_(labels, opts) -> { pdfFile, pdfBlob, pages, count }
 *     labels: [{ qrText, productName, unitQuantity }]
 *
 * 前提:
 *   - 「設定」シートの labelTemplateId に A4縦の Slides テンプレートがあること
 *     （setupFormIntegration() / ensureLabelTemplate_() が LabelTemplate.gs の PPTX から自動作成）
 *   - QR 画像は QRCode.gs の makeQrBlob_ で生成（外部通信なし）
 */

// ラベル用紙の寸法（admin/qr-generator.html の LABEL_CONFIG と同じ値）
var LABEL_SHEET_ = {
  name: 'エーワン 31266',
  perSheet: 8,
  cols: 2,
  rows: 4,
  labelWidthMm: 97,
  labelHeightMm: 69,
  marginTopMm: 10.5,
  marginLeftMm: 8,
  paddingMm: 3,      // 面内の余白（印刷ページの .cell padding）
  qrMm: 58,          // QR の一辺（印刷ページの .qr-container）
  pageWidthPt: 595.28,
  pageHeightPt: 841.89
};

// ラベル文字のスタイル（印刷ページの CSS と同じ）
var LABEL_STYLE_ = {
  nameFontSize: 16,
  nameColor: '#8B0000',
  codeFontSize: 10,
  codeFontFamily: 'Courier New',
  infoFontSize: 11,
  paragraphGapMm: 2
};

function mmToPt_(mm) {
  return mm * 72 / 25.4;
}

/**
 * ラベル面の左上座標（pt）を返す。index は 0..7（左上から右へ、次の段へ）
 */
function labelCellOrigin_(index, offsetXMm, offsetYMm) {
  var col = index % LABEL_SHEET_.cols;
  var row = Math.floor(index / LABEL_SHEET_.cols);
  return {
    x: mmToPt_(LABEL_SHEET_.marginLeftMm + (offsetXMm || 0) + col * LABEL_SHEET_.labelWidthMm),
    y: mmToPt_(LABEL_SHEET_.marginTopMm + (offsetYMm || 0) + row * LABEL_SHEET_.labelHeightMm)
  };
}

/**
 * プレゼンテーションが A4 縦（±2pt）であることを確認する
 */
function assertA4_(presentation) {
  var w = presentation.getPageWidth();
  var h = presentation.getPageHeight();
  if (Math.abs(w - LABEL_SHEET_.pageWidthPt) > 2 || Math.abs(h - LABEL_SHEET_.pageHeightPt) > 2) {
    throw new Error(
      'ラベルテンプレートのページサイズが A4縦 ではありません（現在 ' + w.toFixed(1) + ' x ' + h.toFixed(1) + ' pt）。' +
      'Google スライドでテンプレートを開き「ファイル › ページ設定 › カスタム 21cm × 29.7cm」に変更するか、' +
      '設定シートの labelTemplateId を空にして setupFormIntegration() を再実行してください。'
    );
  }
}

/**
 * ラベルPDF の保存先フォルダを取得（無ければ作成して設定シートに保存）
 */
function getLabelFolder_() {
  var folderId = getConfigValue_('driveFolderId', '');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // ID が無効なら作り直す
    }
  }
  var name = 'お守り在庫管理_ラベルPDF';
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  setConfigValue_('driveFolderId', folder.getId());
  return folder;
}

/**
 * A4縦の Slides テンプレートを用意し、その ID を返す
 * 1. 設定シートの labelTemplateId が有効で A4 ならそれを使う
 * 2. 無ければ LabelTemplate.gs に同梱した PPTX を Drive で Google スライドに変換して作成
 */
function ensureLabelTemplate_() {
  var existingId = getConfigValue_('labelTemplateId', '');
  if (existingId) {
    try {
      var pres = SlidesApp.openById(existingId);
      assertA4_(pres);
      return existingId;
    } catch (e) {
      if (String(e.message || e).indexOf('A4縦') >= 0) throw e; // サイズ違いは案内して止める
      // 開けない（削除済み等）→ 作り直す
    }
  }

  var folder = getLabelFolder_();
  var pptxBlob = getLabelTemplatePptxBlob_();
  var resource = Drive.Files.insert(
    { title: '【テンプレート】お守りラベル A4縦（削除しないでください）',
      mimeType: 'application/vnd.google-apps.presentation',
      parents: [{ id: folder.getId() }] },
    pptxBlob,
    { convert: true }
  );
  var newId = resource.id;
  var created = SlidesApp.openById(newId);
  try {
    assertA4_(created);
  } catch (e) {
    // 変換でサイズが保持されなかった場合: ID は保存し、手動でページ設定を直してもらう
    setConfigValue_('labelTemplateId', newId);
    throw new Error('ラベルテンプレートを作成しましたが、ページサイズが A4縦 になりませんでした。' +
      'Google スライドで「' + created.getName() + '」を開き「ファイル › ページ設定 › カスタム 21cm × 29.7cm」に変更してから、' +
      'setupFormIntegration() を再実行してください。 ' + created.getUrl());
  }
  setConfigValue_('labelTemplateId', newId);
  return newId;
}

/**
 * ラベルPDF を生成して Drive に保存する
 *
 * @param {Array<{qrText:string, productName:string, unitQuantity:number}>} labels 1面につき1要素
 * @param {{fileName?:string, folder?:GoogleAppsScript.Drive.Folder, keepSlides?:boolean}} [opts]
 * @return {{pdfFile: GoogleAppsScript.Drive.File, pdfBlob: GoogleAppsScript.Base.Blob, pages:number, count:number, slidesUrl?:string}}
 */
function buildLabelPdf_(labels, opts) {
  opts = opts || {};
  if (!labels || labels.length === 0) {
    throw new Error('ラベルの内容がありません');
  }
  var maxLabels = Number(getConfigValue_('maxLabelsPerPdf', 200)) || 200;
  if (labels.length > maxLabels) {
    throw new Error('1回に作成できるラベルは ' + maxLabels + ' 枚までです（要求: ' + labels.length + ' 枚）');
  }

  var templateId = ensureLabelTemplate_();
  var folder = opts.folder || getLabelFolder_();
  var baseName = opts.fileName || ('ラベル_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm'));
  var offsetX = Number(getConfigValue_('offsetX_mm', 0)) || 0;
  var offsetY = Number(getConfigValue_('offsetY_mm', 0)) || 0;
  var fontFamily = getConfigValue_('labelFontFamily', 'Noto Sans JP');
  var qrCellSize = Number(getConfigValue_('qrCellSize', 10)) || 10;

  // テンプレートを複製して開く
  var copyFile = DriveApp.getFileById(templateId).makeCopy(baseName + '（作業用）', folder);
  var pres = SlidesApp.openById(copyFile.getId());
  assertA4_(pres);

  var pages = Math.ceil(labels.length / LABEL_SHEET_.perSheet);
  var slides = pres.getSlides();
  // 1枚目を空にして土台にし、必要なページ数だけ複製する
  var first = slides[0];
  first.getPageElements().forEach(function(el) { el.remove(); });
  for (var s = slides.length - 1; s >= 1; s--) slides[s].remove();
  var pageSlides = [first];
  for (var p = 1; p < pages; p++) {
    pageSlides.push(first.duplicate());
  }

  var qrPt = mmToPt_(LABEL_SHEET_.qrMm);
  var padPt = mmToPt_(LABEL_SHEET_.paddingMm);
  var cellHPt = mmToPt_(LABEL_SHEET_.labelHeightMm);
  var cellWPt = mmToPt_(LABEL_SHEET_.labelWidthMm);
  var textLeftInCell = padPt + qrPt;                 // 3mm + 58mm
  var textWidth = cellWPt - textLeftInCell - padPt;  // 97 - 61 - 3 = 33mm
  var textHeight = cellHPt - padPt * 2;              // 63mm

  labels.forEach(function(label, idx) {
    var slide = pageSlides[Math.floor(idx / LABEL_SHEET_.perSheet)];
    var origin = labelCellOrigin_(idx % LABEL_SHEET_.perSheet, offsetX, offsetY);

    // QR（面の左側、上下中央）
    var qrBlob = makeQrBlob_(label.qrText, { cellSize: qrCellSize, name: label.qrText });
    slide.insertImage(qrBlob, origin.x + padPt, origin.y + (cellHPt - qrPt) / 2, qrPt, qrPt);

    // 文字（面の右側）
    var text = String(label.productName || '') + '\n' + String(label.qrText || '') + '\n' +
      '入数: ' + (label.unitQuantity || 0) + '個/箱';
    var box = slide.insertTextBox(text, origin.x + textLeftInCell, origin.y + padPt, textWidth, textHeight);
    box.setContentAlignment(SlidesApp.ContentAlignment.MIDDLE);
    var range = box.getText();
    range.getTextStyle().setFontFamily(fontFamily).setForegroundColor('#000000');
    range.getParagraphStyle().setSpaceBelow(mmToPt_(LABEL_STYLE_.paragraphGapMm))
      .setParagraphAlignment(SlidesApp.ParagraphAlignment.START);
    var paras = range.getParagraphs();
    if (paras[0]) {
      paras[0].getRange().getTextStyle().setFontSize(LABEL_STYLE_.nameFontSize).setBold(true)
        .setForegroundColor(LABEL_STYLE_.nameColor);
    }
    if (paras[1]) {
      paras[1].getRange().getTextStyle().setFontSize(LABEL_STYLE_.codeFontSize).setBold(true)
        .setFontFamily(LABEL_STYLE_.codeFontFamily);
    }
    if (paras[2]) {
      paras[2].getRange().getTextStyle().setFontSize(LABEL_STYLE_.infoFontSize).setBold(true);
    }
  });

  pres.saveAndClose();

  // PDF に変換して保存
  var pdfBlob = DriveApp.getFileById(copyFile.getId()).getAs('application/pdf').setName(baseName + '.pdf');
  var pdfFile = folder.createFile(pdfBlob);
  if (String(getConfigValue_('pdfShareAnyoneWithLink', 'FALSE')).toUpperCase() === 'TRUE') {
    try {
      pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      // 共有設定に失敗しても PDF 自体は使える
    }
  }

  var result = { pdfFile: pdfFile, pdfBlob: pdfBlob, pages: pages, count: labels.length };
  if (opts.keepSlides) {
    result.slidesUrl = copyFile.getUrl();
  } else {
    copyFile.setTrashed(true);
  }
  return result;
}

/**
 * 箱情報（商品ごとの番号リスト）からラベル配列を作る
 * @param {Array<{productCode:string, productName:string, unitQuantity:number, year:string, numbers:number[]}>} items
 */
function labelsFromBoxItems_(items) {
  var labels = [];
  items.forEach(function(item) {
    item.numbers.forEach(function(num) {
      labels.push({
        qrText: formatQrText_(item.productCode, item.year, num),
        productName: item.productName,
        unitQuantity: item.unitQuantity
      });
    });
  });
  return labels;
}

/**
 * QR 文字列を組み立てる（アプリの parseQrCode と同じ書式: CODE-YY-NNNN）
 */
function formatQrText_(productCode, year, number) {
  var yy = String(year).replace(/\D/g, '');
  yy = yy.length >= 2 ? yy.slice(-2) : ('0' + yy).slice(-2);
  var n = String(number);
  while (n.length < 4) n = '0' + n;
  return String(productCode).toUpperCase() + '-' + yy + '-' + n;
}

/**
 * 動作確認用: サンプルの 8面ラベル PDF を作成して URL をログに出す
 * （印刷して用紙との位置合わせを確認する）
 */
function test_sampleLabelPdf() {
  var labels = [];
  for (var i = 1; i <= 8; i++) {
    labels.push({ qrText: formatQrText_('SAMPLE', new Date().getFullYear() % 100, i), productName: 'サンプル守り', unitQuantity: 50 });
  }
  var r = buildLabelPdf_(labels, { fileName: 'ラベル_サンプル_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm'), keepSlides: true });
  Logger.log('PDF: ' + r.pdfFile.getUrl());
  Logger.log('Slides(作業用): ' + r.slidesUrl);
  return r.pdfFile.getUrl();
}
