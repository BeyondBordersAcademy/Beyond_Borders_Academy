// Certificate PDF generation (pdfkit) + QR code (qrcode).
// Navy/gold academy design. Includes the required disclaimer distinguishing
// academy certificates from accredited qualifications.
//
// The PDF is built in memory and uploaded via lib/storage.js: to Supabase
// Storage on production, or to the local uploads/certificates/ directory
// when Supabase is not configured.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('./db');
const { certCode } = require('./helpers');
const storage = require('./storage');

const NAVY = '#0B1F3A';
const GOLD = '#C6A34B';

function certDir() {
  const dir = path.join(__dirname, '..', 'uploads', 'certificates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Build the certificate PDF and resolve with a Buffer (no disk write).
async function buildCertificatePDF({ code, studentName, courseTitle, level, issuedDate, verifyUrl }) {
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 180, margin: 1 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 792, H = 612; // landscape letter in points
    // Background
    doc.rect(0, 0, W, H).fill('#FFFFFF');
    // Navy border frame
    doc.rect(24, 24, W - 48, H - 48).lineWidth(3).stroke(NAVY);
    doc.rect(34, 34, W - 68, H - 68).lineWidth(1).stroke(GOLD);
    // Gold top accent bar
    doc.rect(34, 34, W - 68, 10).fill(GOLD);

    const cx = W / 2;
    let y = 90;
    doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold')
      .text('BEYOND BORDERS ENGLISH ACADEMY', 0, y, { align: 'center', width: W });
    y += 20;
    doc.fillColor('#6b7280').fontSize(9).font('Helvetica-Oblique')
      .text('Breaking Barriers, Building Futures', 0, y, { align: 'center', width: W });
    y += 44;
    doc.fillColor(NAVY).fontSize(34).font('Helvetica-Bold')
      .text('Certificate of Completion', 0, y, { align: 'center', width: W });
    y += 52;
    doc.fillColor('#374151').fontSize(12).font('Helvetica')
      .text('This certificate is proudly presented to', 0, y, { align: 'center', width: W });
    y += 30;
    doc.fillColor(NAVY).fontSize(30).font('Helvetica-Bold')
      .text(studentName, 0, y, { align: 'center', width: W });
    y += 46;
    doc.fillColor('#374151').fontSize(12).font('Helvetica')
      .text(`for successfully completing`, 0, y, { align: 'center', width: W });
    y += 26;
    doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold')
      .text(courseTitle, 0, y, { align: 'center', width: W });
    y += 34;
    if (level) {
      doc.fillColor(GOLD).fontSize(13).font('Helvetica-Bold')
        .text(`Level: ${level}`, 0, y, { align: 'center', width: W });
      y += 24;
    }
    doc.fillColor('#374151').fontSize(11).font('Helvetica')
      .text(`Issued on ${issuedDate}`, 0, y, { align: 'center', width: W });
    y += 22;
    doc.fillColor('#6b7280').fontSize(10).font('Helvetica')
      .text('Authorized signatory: Academy Director', 0, y, { align: 'center', width: W });

    // QR + code bottom-left
    doc.image(qrBuffer, 70, H - 170, { width: 90 });
    doc.fillColor('#374151').fontSize(9).font('Helvetica')
      .text(`Certificate No: ${code}`, 70, H - 70);
    doc.fillColor('#6b7280').fontSize(8)
      .text('Verify at the URL encoded in the QR code.', 70, H - 56);

    // Disclaimer bottom-center
    doc.fillColor('#9ca3af').fontSize(7.5).font('Helvetica-Oblique')
      .text('This certificate of completion is issued by Beyond Borders English Academy. ' +
        'It is not a government-recognized qualification, an accredited credential, or an official CEFR certification.',
        220, H - 62, { width: W - 440, align: 'center' });

    doc.end();
  });
}

// Issue a certificate row + PDF. Caller must verify eligibility first.
async function issueCertificate(userId, courseId, actorId, baseUrl) {
  const user = await db.prepare('SELECT name FROM users WHERE id=?').get(userId);
  const course = await db.prepare('SELECT title, level FROM courses WHERE id=?').get(courseId);
  if (!user || !course) throw new Error('Student or course not found');

  // Avoid duplicates: reuse existing valid cert for same user+course.
  const existing = await db.prepare(
    `SELECT * FROM certificates WHERE user_id=? AND course_id=? AND status='valid'`).get(userId, courseId);
  if (existing) return existing;

  const code = certCode();
  const issuedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify/${code}`;
  const pdfBuffer = await buildCertificatePDF({
    code, studentName: user.name, courseTitle: course.title,
    level: course.level || '', issuedDate, verifyUrl,
  });
  // Upload via storage backend; the returned path is stored in pdf_path with
  // the same "uploads/certificates/<code>.pdf" semantics as before.
  const pdfPath = await storage.uploadBuffer('certificates', `${code}.pdf`, pdfBuffer, 'application/pdf');
  const row = await db.prepare(`INSERT INTO certificates (code, user_id, course_id, pdf_path)
    VALUES (?,?,?,?)`).run(code, userId, courseId, pdfPath);
  const { audit, notify } = require('./helpers');
  audit(actorId, 'certificate.issued', `code=${code} user=${userId} course=${courseId}`);
  notify(userId, 'certificate', 'Certificate issued',
    `Your certificate for "${course.title}" is ready. Code: ${code}`);
  return await db.prepare('SELECT * FROM certificates WHERE id=?').get(row.lastInsertRowid);
}

module.exports = { buildCertificatePDF, issueCertificate, certDir };
