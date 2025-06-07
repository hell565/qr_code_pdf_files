const express = require('express');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');

const app = express();
const PDF_DIR = path.resolve('pdfs');
const DEVICE_DB = 'device_db.txt';
const QR_PDF_MAP = 'qr_pdf_map.txt';
const BASE_URL = process.argv[2] || ''; // вставьте url который дал putty.exe
const QR_CODES_PER_PDF = 30;

// Логирование
const logger = winston.createLogger({
  level: 'info',
  levels: winston.config.npm.levels,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} - ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

app.use('/pdfs', express.static(PDF_DIR));

// HTML-шаблон для PDF
const HTML_TEMPLATE = (pdfUrl) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PDF Viewer</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .pdf-viewer { width: 100%; height: 600px; }
    </style>
</head>
<body>
    <h1>PDF Viewer</h1>
    ${pdfUrl ? `
        <embed src="/pdfs/${pdfUrl}#toolbar=0&navpanes=0" class="pdf-viewer" type="application/pdf">
        <p>Если PDF не отображается, попробуйте другой браузер.</p>
    ` : `
        <p>QR-код недействителен или доступ запрещен.</p>
    `}
</body>
</html>
`;

async function saveDeviceBinding(qrId, deviceId) {
  logger.info(`Сохранение привязки: QR=${qrId}, Device=${deviceId}`);
  try {
    await fs.appendFile(DEVICE_DB, `${qrId}|${deviceId}|${new Date().toISOString()}\n`);
  } catch (e) {
    logger.error(`Ошибка сохранения привязки: ${e}`);
  }
}

async function checkDeviceBinding(qrId, deviceId) {
  try {
    if (!(await exists(DEVICE_DB))) return { isBound: false, deviceMatch: null };
    const data = await fs.readFile(DEVICE_DB, 'utf8');
    const lines = data.split('\n').filter(line => line.trim());
    for (const line of lines) {
      const [storedId, storedDeviceId] = line.split('|');
      if (storedId === qrId) {
        logger.info(`QR-код ${qrId} привязан к ${storedDeviceId}`);
        return { isBound: true, deviceMatch: storedDeviceId === deviceId };
      }
    }
    return { isBound: false, deviceMatch: null };
  } catch (e) {
    logger.error(`Ошибка проверки привязки: ${e}`);
    return { isBound: false, deviceMatch: null };
  }
}

async function saveQrPdfMapping(qrId, pdfFilename) {
  logger.info(`Сохранение связи: QR=${qrId}, PDF=${pdfFilename}`);
  try {
    await fs.appendFile(QR_PDF_MAP, `${qrId}|${pdfFilename}\n`);
    logger.info(`Связь QR=${qrId} с PDF=${pdfFilename} успешно сохранена`);
  } catch (e) {
    logger.error(`Ошибка сохранения связи QR=${qrId} с PDF=${pdfFilename}: ${e}`);
    throw e;
  }
}

async function getPdfForQr(qrId) {
  try {
    if (!(await exists(QR_PDF_MAP))) {
      logger.error('qr_pdf_map.txt не найден');
      return null;
    }
    const data = await fs.readFile(QR_PDF_MAP, 'utf8');
    const lines = data.split('\n').filter(line => line.trim());
    for (const line of lines) {
      const [storedId, pdfFilename] = line.split('|');
      if (storedId === qrId) {
        logger.info(`Найден PDF для QR=${qrId}: ${pdfFilename}`);
        return pdfFilename;
      }
    }
    return null;
  } catch (e) {
    logger.error(`Ошибка чтения qr_pdf_map.txt: ${e}`);
    return null;
  }
}

async function countQrCodesForPdf(pdfFilename) {
  try {
    if (!(await exists(QR_PDF_MAP))) return 0;
    const data = await fs.readFile(QR_PDF_MAP, 'utf8');
    const lines = data.split('\n').filter(line => line.trim());
    return lines.reduce((count, line) => {
      const [, pdf] = line.split('|');
      return count + (pdf === pdfFilename ? 1 : 0);
    }, 0);
  } catch (e) {
    logger.error(`Ошибка подсчета QR-кодов для ${pdfFilename}: ${e}`);
    return 0;
  }
}

async function generateQrCode(pdfFilename, qrId) {
  // Кодируем только qrId в QR-код
  const qrData = qrId;
  try {
    const qrFolder = path.join(PDF_DIR, `qr_${path.parse(pdfFilename).name}`);
    await fs.mkdir(qrFolder, { recursive: true });
    const qrPath = path.join(qrFolder, `qr_${qrId}.png`);
    await qrcode.toFile(qrPath, qrData, { margin: 5 });
    logger.info(`Сгенерирован QR-код: ${qrPath} (содержит только qrId: ${qrId})`);
    return qrPath;
  } catch (e) {
    logger.error(`Ошибка генерации QR-кода для ${pdfFilename}: ${e}`);
    throw e;
  }
}

async function printQrCodes(pdfFilename) {
  logger.info(`Печать QR-кодов для ${pdfFilename} не поддерживается в Express`);
}

async function generateQrCodesForPdfs() {
  const qrCodes = [];
  const existingMappings = {};
  try {
    if (await exists(QR_PDF_MAP)) {
      const data = await fs.readFile(QR_PDF_MAP, 'utf8');
      data.split('\n').filter(line => line.trim()).forEach(line => {
        const [qrId, pdfFilename] = line.split('|');
        if (!existingMappings[pdfFilename]) existingMappings[pdfFilename] = [];
        existingMappings[pdfFilename].push(qrId);
      });
    }
    const pdfFiles = (await fs.readdir(PDF_DIR)).filter(file => file.endsWith('.pdf'));
    for (const pdfFile of pdfFiles) {
      const currentQrCount = existingMappings[pdfFile] ? existingMappings[pdfFile].length : 0;
      const qrToGenerate = QR_CODES_PER_PDF - currentQrCount;
      for (let i = 0; i < Math.max(0, qrToGenerate); i++) {
        const qrId = uuidv4();
        const qrPath = await generateQrCode(pdfFile, qrId);
        await saveQrPdfMapping(qrId, pdfFile);
        qrCodes.push({ pdfFile, qrId, qrPath });
        console.log(`Сгенерирован QR-код для ${pdfFile}: ${qrPath} (qrId: ${qrId})`);
      }
      if (qrToGenerate > 0) await printQrCodes(pdfFile);
    }
    return qrCodes;
  } catch (e) {
    logger.error(`Ошибка генерации QR-кодов: ${e}`);
    return [];
  }
}

app.get('/', (req, res) => {
  logger.info('Запрос на корневую страницу');
  res.send(`
    <h1>QR Code PDF Server</h1>
    <p>Отсканируйте QR-код, чтобы получить qrId. Затем добавьте его к текущему Serveo URL, например: https://<serveo-url>/view/<qrId>.</p>
    <p>Текущий Serveo URL: ${BASE_URL}</p>
  `);
});

app.get('/view/:qrId', async (req, res) => {
  const qrId = req.params.qrId;
  const deviceId = req.headers['user-agent'] + req.ip;
  logger.info(`Запрос на просмотр QR=${qrId} с устройства=${deviceId}`);
  const { isBound, deviceMatch } = await checkDeviceBinding(qrId, deviceId);
  if (isBound && !deviceMatch) {
    logger.warn(`Доступ запрещен для QR=${qrId}`);
    return res.send(HTML_TEMPLATE(null));
  }
  const pdfFilename = await getPdfForQr(qrId);
  if (pdfFilename && await exists(path.join(PDF_DIR, pdfFilename))) {
    if (!isBound) {
      await saveDeviceBinding(qrId, deviceId);
      const qrCount = await countQrCodesForPdf(pdfFilename);
      logger.info(`Текущее количество QR-кодов для ${pdfFilename}: ${qrCount}`);
      if (qrCount < QR_CODES_PER_PDF) {
        try {
          const newQrId = uuidv4();
          logger.info(`Генерация нового QR-кода для ${pdfFilename}: ${newQrId}`);
          await generateQrCode(pdfFilename, newQrId);
          await saveQrPdfMapping(newQrId, pdfFilename);
          logger.info(`Новый QR-код ${newQrId} успешно добавлен для ${pdfFilename}`);
          await printQrCodes(pdfFilename);
        } catch (e) {
          logger.error(`Ошибка при добавлении нового QR-кода: ${e}`);
        }
      } else {
        logger.info(`Достигнуто максимальное количество QR-кодов (${QR_CODES_PER_PDF}) для ${pdfFilename}`);
      }
    }
    const pdfUrl = pdfFilename;
    logger.info(`Отображение PDF: ${pdfFilename}`);
    res.set('Cache-Control', 'no-store, no-cache');
    return res.send(HTML_TEMPLATE(pdfUrl));
  }
  logger.error(`PDF не найден для QR=${qrId}`);
  res.send(HTML_TEMPLATE(null));
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  await generateQrCodesForPdfs();
  app.listen(5000, '0.0.0.0', () => {
    logger.info(`Сервер запущен на ${BASE_URL}`);
    console.log(`Сервер запущен на ${BASE_URL}`);
  });
})();