const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const archiver = require('archiver');
const { ZipArchive } = archiver;

const app = express();
const PORT = process.env.PORT || 3000;

// ── 中间件 ──
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')));

// ── 数据库初始化 ──
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'safety.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    store_name TEXT DEFAULT '',
    store_city TEXT DEFAULT '',
    role TEXT DEFAULT '安全员',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS hazards (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    reporter_name TEXT NOT NULL,
    store_name TEXT DEFAULT '',
    store_city TEXT DEFAULT '',
    category TEXT NOT NULL,
    level TEXT DEFAULT '一般',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    photo_path TEXT DEFAULT '',
    level_law TEXT DEFAULT '',
    level_desc TEXT DEFAULT '',
    level_keywords TEXT DEFAULT '',
    level_confidence TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    rectify_note TEXT DEFAULT '',
    rectify_photo_path TEXT DEFAULT '',
    rectified_at TEXT DEFAULT '',
    discovery_score INTEGER DEFAULT 0,
    rectify_score INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (reporter_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    store_name TEXT DEFAULT '',
    type TEXT NOT NULL,
    score INTEGER NOT NULL,
    hazard_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── 图片上传配置 ──
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) {
    var ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + ext);
  }
});
var upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── 工具函数 ──
function genId(prefix) { return prefix + Date.now() + Math.random().toString(36).substr(2, 5); }

function rowToCamel(row) {
  if (!row) return row;
  var obj = {};
  Object.keys(row).forEach(function(k) {
    var parts = k.split('_');
    var camel = parts[0] + parts.slice(1).map(function(p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join('');
    obj[camel] = row[k];
  });
  return obj;
}

function rowsToCamel(rows) { return rows.map(rowToCamel); }

var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'safety2026';

// ══════════════════════════════════════════════
// API 路由
// ══════════════════════════════════════════════

// ── 用户注册 ──
app.post('/api/users/register', function(req, res) {
  try {
    var d = req.body;
    if (!d.name || !d.phone) return res.json({ success: false, msg: '姓名和手机号必填' });
    var existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(d.phone);
    if (existing) return res.json({ success: false, msg: '该手机号已注册', user: rowToCamel(existing) });
    var id = genId('U');
    db.prepare('INSERT INTO users (id, name, phone, store_name, store_city, role) VALUES (?,?,?,?,?,?)')
      .run(id, d.name, d.phone, d.storeName || '', d.storeCity || '', d.role || '安全员');
    var user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.json({ success: true, user: rowToCamel(user) });
  } catch (e) {
    res.json({ success: false, msg: '注册失败：' + e.message });
  }
});

// ── 用户登录 ──
app.post('/api/users/login', function(req, res) {
  try {
    var phone = req.body.phone;
    if (!phone) return res.json({ success: false, msg: '请输入手机号' });
    var user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (user) return res.json({ success: true, user: rowToCamel(user) });
    res.json({ success: false, msg: '用户未注册，请先注册' });
  } catch (e) {
    res.json({ success: false, msg: '登录失败：' + e.message });
  }
});

// ── 获取所有用户 ──
app.get('/api/users', function(req, res) {
  try {
    var users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    res.json(rowsToCamel(users));
  } catch (e) {
    res.json([]);
  }
});

// ── 图片上传 ──
app.post('/api/upload', upload.single('photo'), function(req, res) {
  if (!req.file) return res.json({ success: false, msg: '未收到文件' });
  var relPath = '/uploads/' + req.file.filename;
  res.json({ success: true, path: relPath, url: relPath });
});

// ── 提交隐患 ──
app.post('/api/hazards', function(req, res) {
  try {
    var d = req.body;
    if (!d.title || !d.reporterId) return res.json({ success: false, msg: '缺少必填字段' });
    var id = genId('H');
    var scoreMap = { '重大': 20, '较大': 10, '一般': 5 };
    var discoveryScore = scoreMap[d.level] || 5;

    db.prepare(`INSERT INTO hazards (id, reporter_id, reporter_name, store_name, store_city, category, level, title, description, location, photo_path, level_law, level_desc, level_keywords, level_confidence, discovery_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, d.reporterId, d.reporterName || '', d.storeName || '', d.storeCity || '', d.category || '', d.level || '一般', d.title, d.description || '', d.location || '', d.photoPath || '', d.levelLaw || '', d.levelDesc || '', d.levelKeywords || '', d.levelConfidence || '', discoveryScore);

    // 记录积分
    var scoreId = genId('S');
    db.prepare('INSERT INTO scores (id, user_id, store_name, type, score, hazard_id) VALUES (?,?,?,?,?,?)')
      .run(scoreId, d.reporterId, d.storeName || '', 'discovery', discoveryScore, id);

    var hazard = db.prepare('SELECT * FROM hazards WHERE id = ?').get(id);
    res.json({ success: true, hazard: rowToCamel(hazard) });
  } catch (e) {
    res.json({ success: false, msg: '提交失败：' + e.message });
  }
});

// ── 获取隐患列表 ──
app.get('/api/hazards', function(req, res) {
  try {
    var sql = 'SELECT * FROM hazards WHERE 1=1';
    var params = [];
    if (req.query.category) { sql += ' AND category = ?'; params.push(req.query.category); }
    if (req.query.level) { sql += ' AND level = ?'; params.push(req.query.level); }
    if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status); }
    if (req.query.reporterId) { sql += ' AND reporter_id = ?'; params.push(req.query.reporterId); }
    sql += ' ORDER BY created_at DESC';
    var hazards = db.prepare(sql).all(params);
    res.json(rowsToCamel(hazards));
  } catch (e) {
    res.json([]);
  }
});

// ── 获取单个隐患 ──
app.get('/api/hazards/:id', function(req, res) {
  try {
    var h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(req.params.id);
    if (!h) return res.json({ success: false, msg: '未找到' });
    res.json(rowToCamel(h));
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

// ── 提交整改 ──
app.put('/api/hazards/:id/rectify', function(req, res) {
  try {
    var id = req.params.id;
    var d = req.body;
    var h = db.prepare('SELECT * FROM hazards WHERE id = ?').get(id);
    if (!h) return res.json({ success: false, msg: '未找到该隐患' });
    var scoreMap = { '重大': 30, '较大': 15, '一般': 8 };
    var rectScore = scoreMap[h.level] || 8;

    db.prepare(`UPDATE hazards SET status='completed', rectify_note=?, rectify_photo_path=?, rectified_at=datetime('now','localtime'), rectify_score=? WHERE id=?`)
      .run(d.rectifyNote || '', d.rectifyPhotoPath || '', rectScore, id);

    // 记录积分
    var scoreId = genId('S');
    db.prepare('INSERT INTO scores (id, user_id, store_name, type, score, hazard_id) VALUES (?,?,?,?,?,?)')
      .run(scoreId, h.reporter_id, h.store_name, 'rectify', rectScore, id);

    var updated = db.prepare('SELECT * FROM hazards WHERE id = ?').get(id);
    res.json({ success: true, hazard: rowToCamel(updated) });
  } catch (e) {
    res.json({ success: false, msg: '整改提交失败：' + e.message });
  }
});

// ── 积分排行 - 个人 ──
app.get('/api/scores/ranking', function(req, res) {
  try {
    var users = db.prepare('SELECT * FROM users').all();
    var hazards = db.prepare('SELECT * FROM hazards').all();
    var result = users.map(function(u) {
      var uH = hazards.filter(function(h) { return h.reporter_id === u.id; });
      var discoveryScore = uH.reduce(function(s, h) { return s + (h.discovery_score || 0); }, 0);
      var rectifyScore = uH.filter(function(h) { return h.status === 'completed'; }).reduce(function(s, h) { return s + (h.rectify_score || 0); }, 0);
      return {
        userId: u.id, name: u.name, storeName: u.store_name, storeCity: u.store_city,
        totalHazards: uH.length, completedHazards: uH.filter(function(h) { return h.status === 'completed'; }).length,
        discoveryScore: discoveryScore, rectifyScore: rectifyScore,
        totalScore: discoveryScore + rectifyScore
      };
    }).sort(function(a, b) { return b.totalScore - a.totalScore; });
    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// ── 积分排行 - 门店 ──
app.get('/api/scores/store-ranking', function(req, res) {
  try {
    var hazards = db.prepare('SELECT * FROM hazards').all();
    var storeMap = {};
    hazards.forEach(function(h) {
      if (!storeMap[h.store_name]) {
        storeMap[h.store_name] = { storeName: h.store_name, storeCity: h.store_city, totalHazards: 0, completedHazards: 0, totalScore: 0 };
      }
      storeMap[h.store_name].totalHazards++;
      storeMap[h.store_name].totalScore += (h.discovery_score || 0);
      if (h.status === 'completed') {
        storeMap[h.store_name].completedHazards++;
        storeMap[h.store_name].totalScore += (h.rectify_score || 0);
      }
    });
    var result = Object.values(storeMap).sort(function(a, b) { return b.totalScore - a.totalScore; });
    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// ── 管理员登录验证 ──
app.post('/api/admin/login', function(req, res) {
  var pass = req.body.password;
  res.json({ success: pass === ADMIN_PASSWORD });
});

// ── 管理后台统计 ──
app.get('/api/admin/stats', function(req, res) {
  try {
    var userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    var hazardCount = db.prepare('SELECT COUNT(*) as c FROM hazards').get().c;
    var completedCount = db.prepare("SELECT COUNT(*) as c FROM hazards WHERE status='completed'").get().c;
    var totalScore = db.prepare('SELECT COALESCE(SUM(discovery_score),0) + COALESCE(SUM(rectify_score),0) as s FROM hazards').get().s;
    res.json({ userCount: userCount, hazardCount: hazardCount, completedCount: completedCount, totalScore: totalScore });
  } catch (e) {
    res.json({ userCount: 0, hazardCount: 0, completedCount: 0, totalScore: 0 });
  }
});

// ── 导出隐患数据（含照片ZIP包） ──
app.get('/api/admin/export/hazards', function(req, res) {
  try {
    var hazards = db.prepare('SELECT * FROM hazards ORDER BY created_at DESC').all();
    var users = db.prepare('SELECT * FROM users').all();
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u; });
    var header = ['隐患ID','门店名称','城市','上报人','联系电话','安全类别','危险等级','等级判定方式','法规依据','判定说明','匹配关键词','隐患标题','隐患描述','位置','上报时间','整改状态','整改说明','整改时间','发现积分','整改积分','合计积分','隐患照片','整改照片'];
    var rows = hazards.map(function(h) {
      var u = userMap[h.reporter_id] || {};
      var photoName = '';
      if (h.photo_path) {
        var pParts = h.photo_path.split('/');
        photoName = 'photos/' + h.id + '_report.' + pParts[pParts.length - 1].split('.').pop();
      }
      var rectPhotoName = '';
      if (h.rectify_photo_path) {
        var rParts = h.rectify_photo_path.split('/');
        rectPhotoName = 'photos/' + h.id + '_rectify.' + rParts[rParts.length - 1].split('.').pop();
      }
      return [
        h.id, h.store_name, h.store_city, h.reporter_name, u.phone || '',
        h.category, h.level,
        h.level_confidence ? '智能识别' : '手动选择',
        h.level_law || '', h.level_desc || '', h.level_keywords || '',
        h.title, h.description, h.location,
        h.created_at || '',
        h.status === 'completed' ? '已整改' : '待整改',
        h.rectify_note || '', h.rectified_at || '',
        h.discovery_score, h.rectify_score, (h.discovery_score || 0) + (h.rectify_score || 0),
        photoName || '无', rectPhotoName || '无'
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; });
    });
    var csv = [header.map(function(v) { return '"' + v + '"'; }).join(','), rows.map(function(r) { return r.join(','); }).join('\n')].join('\n');

    // 创建ZIP文件（CSV + 照片）
    var archive = new ZipArchive({ zlib: { level: 5 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=hazards_with_photos.zip');
    archive.pipe(res);
    // 添加CSV
    archive.append('\uFEFF' + csv, { name: 'hazards_data.csv' });
    // 添加照片文件（用英文文件名避免乱码）
    hazards.forEach(function(h) {
      if (h.photo_path) {
        var filePath = path.join(__dirname, h.photo_path);
        if (fs.existsSync(filePath)) {
          var ext = h.photo_path.split('.').pop();
          archive.file(filePath, { name: 'photos/' + h.id + '_report.' + ext });
        }
      }
      if (h.rectify_photo_path) {
        var rectPath = path.join(__dirname, h.rectify_photo_path);
        if (fs.existsSync(rectPath)) {
          var rext = h.rectify_photo_path.split('.').pop();
          archive.file(rectPath, { name: 'photos/' + h.id + '_rectify.' + rext });
        }
      }
    });
    archive.finalize();
  } catch (e) {
    res.status(500).send('Export error: ' + e.message);
  }
});

// ── 导出CSV - 人员积分 ──
app.get('/api/admin/export/users', function(req, res) {
  try {
    var users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    var hazards = db.prepare('SELECT * FROM hazards').all();
    var header = ['姓名','手机号','城市','门店','岗位','发现隐患','整改完成','总积分','注册时间'];
    var rows = users.map(function(u) {
      var uH = hazards.filter(function(h) { return h.reporter_id === u.id; });
      var score = uH.reduce(function(s, h) { return s + (h.discovery_score || 0) + (h.rectify_score || 0); }, 0);
      return [u.name, u.phone, u.store_city, u.store_name, u.role, uH.length, uH.filter(function(h) { return h.status === 'completed'; }).length, score, u.created_at || '']
        .map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; });
    });
    var csv = [header.map(function(v) { return '"' + v + '"'; }).join(','), rows.map(function(r) { return r.join(','); }).join('\n')].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).send('Export error: ' + e.message);
  }
});

// ── 导出CSV - 门店排行 ──
app.get('/api/admin/export/ranking', function(req, res) {
  try {
    var hazards = db.prepare('SELECT * FROM hazards').all();
    var storeMap = {};
    hazards.forEach(function(h) {
      if (!storeMap[h.store_name]) {
        storeMap[h.store_name] = { storeName: h.store_name, storeCity: h.store_city, totalHazards: 0, completedHazards: 0, totalScore: 0 };
      }
      storeMap[h.store_name].totalHazards++;
      storeMap[h.store_name].totalScore += (h.discovery_score || 0);
      if (h.status === 'completed') {
        storeMap[h.store_name].completedHazards++;
        storeMap[h.store_name].totalScore += (h.rectify_score || 0);
      }
    });
    var rank = Object.values(storeMap).sort(function(a, b) { return b.totalScore - a.totalScore; });
    var header = ['排名','门店名称','城市','发现隐患数','整改完成数','总积分'];
    var rows = rank.map(function(r, i) {
      return [i + 1, r.storeName, r.storeCity, r.totalHazards, r.completedHazards, r.totalScore]
        .map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; });
    });
    var csv = [header.map(function(v) { return '"' + v + '"'; }).join(','), rows.map(function(r) { return r.join(','); }).join('\n')].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ranking.csv');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).send('Export error: ' + e.message);
  }
});

// ── 管理员删除隐患 ──
app.delete('/api/admin/hazards/:id', function(req, res) {
  try {
    var info = db.prepare('DELETE FROM hazards WHERE id = ?').run(req.params.id);
    if (info.changes > 0) {
      res.json({ success: true, message: '隐患已删除' });
    } else {
      res.json({ success: false, message: '隐患不存在' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── 管理员删除用户（同时删除该用户的所有隐患） ──
app.delete('/api/admin/users/:id', function(req, res) {
  try {
    var userHazards = db.prepare('SELECT photo_path, rectify_photo_path FROM hazards WHERE reporter_id = ?').all(req.params.id);
    // 删除关联隐患的照片文件
    var fs = require('fs');
    userHazards.forEach(function(h) {
      try { if (h.photo_path) fs.unlinkSync(path.join(__dirname, h.photo_path)); } catch(e) {}
      try { if (h.rectify_photo_path) fs.unlinkSync(path.join(__dirname, h.rectify_photo_path)); } catch(e) {}
    });
    db.prepare('DELETE FROM hazards WHERE reporter_id = ?').run(req.params.id);
    var info = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    if (info.changes > 0) {
      res.json({ success: true, message: '用户及关联隐患已删除' });
    } else {
      res.json({ success: false, message: '用户不存在' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── SPA 回退：所有非API请求返回 index.html ──
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 启动服务器 ──
app.listen(PORT, '0.0.0.0', function() {
  console.log('========================================');
  console.log('  安全生产月小游戏服务器已启动！');
  console.log('  本机: http://localhost:' + PORT);
  console.log('  局域网: http://192.168.3.180:' + PORT);
  console.log('  管理员密码: ' + ADMIN_PASSWORD);
  console.log('========================================');
});
