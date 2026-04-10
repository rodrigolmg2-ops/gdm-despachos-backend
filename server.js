require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');

// ============================================
// CONFIGURAÇÃO DO EXPRESS
// ============================================
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// ============================================
// CONFIGURAÇÃO GOOGLE DRIVE
// ============================================
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');

const driveAuth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({
  version: 'v3',
  auth: driveAuth,
});

// ============================================
// CONFIGURAÇÃO MULTER (upload)
// ============================================
const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// VARIÁVEIS GLOBAIS (cache)
// ============================================
let DESPACHO_GDM_FOLDER_ID = process.env.DESPACHO_GDM_FOLDER_ID || '';
let modelsCache = {};
let acervoCache = {};
let lastCacheUpdate = 0;
const CACHE_DURATION = 3600000; // 1 hora

// ============================================
// FUNÇÃO: Extrair ID de link do Google Drive
// ============================================
function extractFolderId(driveLink) {
  const patterns = [
    /\/folders\/([a-zA-Z0-9-_]+)/,
    /id=([a-zA-Z0-9-_]+)/,
    /^([a-zA-Z0-9-_]+)$/,
  ];

  for (const pattern of patterns) {
    const match = driveLink.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ============================================
// FUNÇÃO: Listar arquivos Google Drive
// ============================================
async function listFilesInFolder(folderId, mimeType = null) {
  try {
    let query = `'${folderId}' in parents and trashed=false`;
    if (mimeType) {
      query += ` and mimeType='${mimeType}'`;
    }

    const res = await drive.files.list({
      q: query,
      spaces: 'drive',
      fields: 'files(id, name, mimeType, webViewLink)',
      pageSize: 100,
    });

    return res.data.files || [];
  } catch (error) {
    console.error('Erro ao listar arquivos:', error.message);
    return [];
  }
}

// ============================================
// FUNÇÃO: Download de PDF
// ============================================
async function downloadPDF(fileId) {
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    return res.data;
  } catch (error) {
    console.error('Erro ao fazer download:', error.message);
    return null;
  }
}

// ============================================
// FUNÇÃO: Extrair texto de PDF
// ============================================
async function extractTextFromPDF(pdfBuffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBuffer);
    return data.text;
  } catch (error) {
    console.error('Erro ao extrair PDF:', error.message);
    return '';
  }
}

// ============================================
// FUNÇÃO: Indexar modelos do Drive
// ============================================
async function indexModels(folderId) {
  try {
    const files = await listFilesInFolder(folderId, 'application/pdf');
    
    modelsCache = {};
    for (const file of files) {
      modelsCache[file.name] = {
        id: file.id,
        name: file.name,
        link: file.webViewLink,
      };
    }

    lastCacheUpdate = Date.now();
    console.log(`✅ ${files.length} modelos indexados`);
    return Object.values(modelsCache);
  } catch (error) {
    console.error('Erro ao indexar modelos:', error.message);
    return [];
  }
}

// ============================================
// FUNÇÃO: Indexar acervo de processos
// ============================================
async function indexAcervo(folderId) {
  try {
    // Buscar subpasta "acervo de processos"
    const folders = await listFilesInFolder(folderId, 'application/vnd.google-apps.folder');
    const acervoFolder = folders.find(f => 
      f.name.toLowerCase().includes('acervo') || 
      f.name.toLowerCase().includes('processos')
    );

    if (!acervoFolder) {
      console.warn('⚠️ Pasta acervo não encontrada');
      return [];
    }

    const files = await listFilesInFolder(acervoFolder.id, 'application/pdf');
    
    acervoCache = {};
    for (const file of files) {
      acervoCache[file.name] = {
        id: file.id,
        name: file.name,
        link: file.webViewLink,
      };
    }

    console.log(`✅ ${files.length} processos do acervo indexados`);
    return Object.values(acervoCache);
  } catch (error) {
    console.error('Erro ao indexar acervo:', error.message);
    return [];
  }
}

// ============================================
// FUNÇÃO: Chamar Claude API
// ============================================
async function analyzeWithClaude(processContent, playbook, modelsInfo, acervoInfo) {
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Você é um analista especializado em despachos do GDM (Gabinete da Diretoria de Materiais) do TCESP.

Sua tarefa é analisar o processo enviado e, seguindo rigorosamente o Playbook Operacional GDM, executar as 7 etapas obrigatórias:

1. Identificar o objeto do processo
2. Classificar o tipo de processo
3. Identificar a fase processual
4. Definir o destino correto do despacho
5. Selecionar o modelo GDM compatível
6. Verificar inconsistências documentais
7. Redigir o despacho adaptado ao caso concreto

PLAYBOOK:
${playbook}

MODELOS DISPONÍVEIS:
${JSON.stringify(modelsInfo, null, 2)}

EXEMPLOS DO ACERVO:
${JSON.stringify(acervoInfo.slice(0, 3), null, 2)}

PROCESSO A ANALISAR:
${processContent}

Responda EXATAMENTE neste formato:

### ENQUADRAMENTO
**Tipo de processo:** [...]
**Objeto:** [...]
**Fase atual:** [...]
**Destinatário do despacho:** [...]
**Modelo GDM aplicável:** [...]

### ALERTAS E INCONSISTÊNCIAS
[...]

### MINUTA DO DESPACHO
[...]`,
        },
      ],
    }, {
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'content-type': 'application/json',
      },
    });

    return response.data.content[0].text;
  } catch (error) {
    console.error('Erro ao chamar Claude:', error.message);
    throw error;
  }
}

// ============================================
// FUNÇÃO: Salvar despacho no Drive
// ============================================
async function saveDespachoToDrive(despachoContent, nomeArquivo, folderId) {
  try {
    // Buscar ou criar pasta "Despachos Gerados"
    let despachosFolderId = null;
    const folders = await listFilesInFolder(folderId, 'application/vnd.google-apps.folder');
    const despachoFolder = folders.find(f => f.name.toLowerCase().includes('gerado'));

    if (despachoFolder) {
      despachosFolderId = despachoFolder.id;
    } else {
      // Criar pasta
      const newFolder = await drive.files.create({
        resource: {
          name: 'Despachos Gerados',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [folderId],
        },
        fields: 'id',
      });
      despachosFolderId = newFolder.data.id;
    }

    // Salvar arquivo
    const fileMetadata = {
      name: nomeArquivo,
      parents: [despachosFolderId],
    };

    const media = {
      mimeType: 'text/plain',
      body: despachoContent,
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
    });

    return file.data;
  } catch (error) {
    console.error('Erro ao salvar no Drive:', error.message);
    throw error;
  }
}

// ============================================
// ROTAS
// ============================================

// 1. ROTA: Configurar folder ID
app.post('/api/setup', (req, res) => {
  const { folderLink } = req.body;

  if (!folderLink) {
    return res.status(400).json({ error: 'folderLink é obrigatório' });
  }

  const folderId = extractFolderId(folderLink);
  if (!folderId) {
    return res.status(400).json({ error: 'Não consegui extrair o ID do link' });
  }

  DESPACHO_GDM_FOLDER_ID = folderId;
  process.env.DESPACHO_GDM_FOLDER_ID = folderId;

  res.json({ 
    success: true, 
    folderId,
    message: 'Folder configurado com sucesso' 
  });
});

// 2. ROTA: Indexar modelos
app.post('/api/index-models', async (req, res) => {
  if (!DESPACHO_GDM_FOLDER_ID) {
    return res.status(400).json({ error: 'Folder não configurado. Use /api/setup primeiro' });
  }

  try {
    const models = await indexModels(DESPACHO_GDM_FOLDER_ID);
    res.json({ success: true, models, count: models.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. ROTA: Indexar acervo
app.post('/api/index-acervo', async (req, res) => {
  if (!DESPACHO_GDM_FOLDER_ID) {
    return res.status(400).json({ error: 'Folder não configurado. Use /api/setup primeiro' });
  }

  try {
    const acervo = await indexAcervo(DESPACHO_GDM_FOLDER_ID);
    res.json({ success: true, acervo, count: acervo.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. ROTA: Analisar processo
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  if (!DESPACHO_GDM_FOLDER_ID) {
    return res.status(400).json({ error: 'Folder não configurado. Use /api/setup primeiro' });
  }

  try {
    const { processText, playbook } = req.body;
    let contentToAnalyze = processText || '';

    // Se enviou PDF
    if (req.file) {
      const extractedText = await extractTextFromPDF(req.file.buffer);
      contentToAnalyze = extractedText;
    }

    if (!contentToAnalyze) {
      return res.status(400).json({ error: 'Envie processText ou um arquivo PDF' });
    }

    if (!playbook) {
      return res.status(400).json({ error: 'playbook é obrigatório' });
    }

    // Reindexar se cache expirou
    if (Date.now() - lastCacheUpdate > CACHE_DURATION) {
      await indexModels(DESPACHO_GDM_FOLDER_ID);
      await indexAcervo(DESPACHO_GDM_FOLDER_ID);
    }

    const modelsInfo = Object.values(modelsCache);
    const acervoInfo = Object.values(acervoCache);

    const analysis = await analyzeWithClaude(
      contentToAnalyze,
      playbook,
      modelsInfo,
      acervoInfo
    );

    // Salvar no Drive
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `Despacho_${timestamp}.txt`;
    const savedFile = await saveDespachoToDrive(analysis, fileName, DESPACHO_GDM_FOLDER_ID);

    res.json({
      success: true,
      analysis,
      savedFile: {
        id: savedFile.id,
        link: savedFile.webViewLink,
        name: fileName,
      },
    });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. ROTA: Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    folderConfigured: !!DESPACHO_GDM_FOLDER_ID,
    modelsCount: Object.keys(modelsCache).length,
    acervoCount: Object.keys(acervoCache).length,
  });
});

// ============================================
// INICIALIZAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 GDM Backend rodando na porta ${PORT}`);
  console.log(`Envs configuradas:`, {
    hasServiceAccount: !!process.env.GOOGLE_SERVICE_ACCOUNT,
    hasClaudeKey: !!process.env.CLAUDE_API_KEY,
    hasFolderId: !!process.env.DESPACHO_GDM_FOLDER_ID,
  });
});

module.exports = app;
