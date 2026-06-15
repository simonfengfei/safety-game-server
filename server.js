const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const archiver = require('archiver');
const { ZipArchive } = archiver;

const app = express();
const PORT = process.env.PORT || 3000;

// ── 中间件 ──
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

// ── PostgreSQL 连接 ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/safety',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── 数据库初始化 ──
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        store_name TEXT DEFAULT '',
        store_city TEXT DEFAULT '',
        role TEXT DEFAULT '安全员',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS hazards (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reporter_name TEXT DEFAULT '',
        store_name TEXT DEFAULT '',
        store_city TEXT DEFAULT '',
        category TEXT NOT NULL,
        level TEXT DEFAULT '一般',
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        location TEXT DEFAULT '',
        photo_data TEXT DEFAULT '',
        photo_mimetype TEXT DEFAULT '',
        rectify_photo_data TEXT DEFAULT '',
        rectify_photo_mimetype TEXT DEFAULT '',
        level_law TEXT DEFAULT '',
        level_desc TEXT DEFAULT '',
        level_keywords TEXT DEFAULT '',
        level_confidence TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        rectify_note TEXT DEFAULT '',
        rectified_at TIMESTAMP,
        discovery_score INTEGER DEFAULT 0,
        rectify_score INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS scores (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        store_name TEXT DEFAULT '',
        type TEXT NOT NULL,
        score INTEGER NOT NULL,
        hazard_id TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } finally {
    client.release();
  }
  console.log('Database initialized');
}

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
app.post('/api/users/register', async function(req, res) {
  try {
    var d = req.body;
    if (!d.name || !d.phone) return res.json({ success: false, msg: '姓名和手机号必填' });
    var existing = await pool.query('SELECT * FROM users WHERE phone = $1', [d.phone]);
    if (existing.rows.length > 0) return res.json({ success: false, msg: '该手机号已注册', user: rowToCamel(existing.rows[0]) });
    var id = genId('U');
    await pool.query('INSERT INTO users (id, name, phone, store_name, store_city, role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, d.name, d.phone, d.storeName || '', d.storeCity || '', d.role || '安全员']);
    var user = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    res.json({ success: true, user: rowToCamel(user.rows[0]) });
  } catch (e) {
    res.json({ success: false, msg: '注册失败：' + e.message });
  }
});

// ── 用户登录 ──
app.post('/api/users/login', async function(req, res) {
  try {
    var phone = req.body.phone;
    if (!phone) return res.json({ success: false, msg: '请输入手机号' });
    var result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length > 0) return res.json({ success: true, user: rowToCamel(result.rows[0]) });
    res.json({ success: false, msg: '用户未注册，请先注册' });
  } catch (e) {
    res.json({ success: false, msg: '登录失败：' + e.message });
  }
});

// ── 获取所有用户 ──
app.get('/api/users', async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json(rowsToCamel(result.rows));
  } catch (e) {
    res.json([]);
  }
});

// ── 提交隐患 ──
app.post('/api/hazards', async function(req, res) {
  try {
    var d = req.body;
    if (!d.title || !d.reporterId) return res.json({ success: false, msg: '缺少必填字段' });
    var id = genId('H');
    var scoreMap = { '重大': 20, '较大': 10, '一般': 5 };
    var discoveryScore = scoreMap[d.level] || 5;

    await pool.query(
      `INSERT INTO hazards (id, reporter_id, reporter_name, store_name, store_city, category, level, title, description, location, photo_data, photo_mimetype, level_law, level_desc, level_keywords, level_confidence, discovery_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, d.reporterId, d.reporterName || '', d.storeName || '', d.storeCity || '', d.category || '', d.level || '一般', d.title, d.description || '', d.location || '', d.photoData || '', d.photoMimetype || '', d.levelLaw || '', d.levelDesc || '', d.levelKeywords || '', d.levelConfidence || '', discoveryScore]
    );

    // 记录积分
    var scoreId = genId('S');
    await pool.query('INSERT INTO scores (id, user_id, store_name, type, score, hazard_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [scoreId, d.reporterId, d.storeName || '', 'discovery', discoveryScore, id]);

    var hazard = await pool.query('SELECT * FROM hazards WHERE id = $1', [id]);
    res.json({ success: true, hazard: rowToCamel(hazard.rows[0]) });
  } catch (e) {
    res.json({ success: false, msg: '提交失败：' + e.message });
  }
});

// ── 获取隐患列表（不含大字段photo_data/rectify_photo_data） ──
app.get('/api/hazards', async function(req, res) {
  try {
    var sql = 'SELECT id, reporter_id, reporter_name, store_name, store_city, category, level, title, description, location, CASE WHEN photo_data != \'\' THEN true ELSE false END as has_photo, CASE WHEN rectify_photo_data != \'\' THEN true ELSE false END as has_rectify_photo, level_law, level_desc, level_keywords, level_confidence, status, rectify_note, rectified_at, discovery_score, rectify_score, created_at FROM hazards WHERE 1=1';
    var params = [];
    var idx = 1;
    if (req.query.category) { sql += ' AND category = $' + idx; params.push(req.query.category); idx++; }
    if (req.query.level) { sql += ' AND level = $' + idx; params.push(req.query.level); idx++; }
    if (req.query.status) { sql += ' AND status = $' + idx; params.push(req.query.status); idx++; }
    if (req.query.reporterId) { sql += ' AND reporter_id = $' + idx; params.push(req.query.reporterId); idx++; }
    sql += ' ORDER BY created_at DESC';
    var result = await pool.query(sql, params);
    res.json(rowsToCamel(result.rows));
  } catch (e) {
    console.error('hazards list error:', e.message);
    res.json([]);
  }
});

// ── 获取隐患照片 ──
app.get('/api/hazards/:id/photo', async function(req, res) {
  try {
    var result = await pool.query('SELECT photo_data, photo_mimetype FROM hazards WHERE id = $1', [req.params.id]);
    if (result.rows.length > 0 && result.rows[0].photo_data) {
      var buffer = Buffer.from(result.rows[0].photo_data, 'base64');
      res.type(result.rows[0].photo_mimetype || 'image/jpeg');
      res.send(buffer);
    } else {
      res.status(404).send('Not found');
    }
  } catch (e) {
    res.status(500).send('Error');
  }
});

// ── 获取整改照片 ──
app.get('/api/hazards/:id/rectify-photo', async function(req, res) {
  try {
    var result = await pool.query('SELECT rectify_photo_data, rectify_photo_mimetype FROM hazards WHERE id = $1', [req.params.id]);
    if (result.rows.length > 0 && result.rows[0].rectify_photo_data) {
      var buffer = Buffer.from(result.rows[0].rectify_photo_data, 'base64');
      res.type(result.rows[0].rectify_photo_mimetype || 'image/jpeg');
      res.send(buffer);
    } else {
      res.status(404).send('Not found');
    }
  } catch (e) {
    res.status(500).send('Error');
  }
});

// ── 获取单个隐患 ──
app.get('/api/hazards/:id', async function(req, res) {
  try {
    var result = await pool.query('SELECT id, reporter_id, reporter_name, store_name, store_city, category, level, title, description, location, CASE WHEN photo_data != \'\' THEN true ELSE false END as has_photo, CASE WHEN rectify_photo_data != \'\' THEN true ELSE false END as has_rectify_photo, level_law, level_desc, level_keywords, level_confidence, status, rectify_note, rectified_at, discovery_score, rectify_score, created_at FROM hazards WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.json({ success: false, msg: '未找到' });
    res.json(rowToCamel(result.rows[0]));
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

// ── 提交整改 ──
app.put('/api/hazards/:id/rectify', async function(req, res) {
  try {
    var id = req.params.id;
    var d = req.body;
    var hResult = await pool.query('SELECT * FROM hazards WHERE id = $1', [id]);
    if (hResult.rows.length === 0) return res.json({ success: false, msg: '未找到该隐患' });
    var h = hResult.rows[0];
    var scoreMap = { '重大': 30, '较大': 15, '一般': 8 };
    var rectScore = scoreMap[h.level] || 8;

    await pool.query(
      `UPDATE hazards SET status='completed', rectify_note=$1, rectify_photo_data=$2, rectify_photo_mimetype=$3, rectified_at=CURRENT_TIMESTAMP, rectify_score=$4 WHERE id=$5`,
      [d.rectifyNote || '', d.rectifyPhotoData || '', d.rectifyPhotoMimetype || '', rectScore, id]
    );

    // 记录积分
    var scoreId = genId('S');
    await pool.query('INSERT INTO scores (id, user_id, store_name, type, score, hazard_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [scoreId, h.reporter_id, h.store_name, 'rectify', rectScore, id]);

    var updated = await pool.query('SELECT * FROM hazards WHERE id = $1', [id]);
    res.json({ success: true, hazard: rowToCamel(updated.rows[0]) });
  } catch (e) {
    res.json({ success: false, msg: '整改提交失败：' + e.message });
  }
});

// ── 积分排行 - 个人 ──
app.get('/api/scores/ranking', async function(req, res) {
  try {
    var usersResult = await pool.query('SELECT * FROM users');
    var hazardsResult = await pool.query('SELECT * FROM hazards');
    var users = usersResult.rows;
    var hazards = hazardsResult.rows;
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
app.get('/api/scores/store-ranking', async function(req, res) {
  try {
    var hazardsResult = await pool.query('SELECT * FROM hazards');
    var hazards = hazardsResult.rows;
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
app.get('/api/admin/stats', async function(req, res) {
  try {
    var uc = await pool.query('SELECT COUNT(*) as c FROM users');
    var hc = await pool.query('SELECT COUNT(*) as c FROM hazards');
    var cc = await pool.query("SELECT COUNT(*) as c FROM hazards WHERE status='completed'");
    var sc = await pool.query('SELECT COALESCE(SUM(discovery_score),0) + COALESCE(SUM(rectify_score),0) as s FROM hazards');
    res.json({ userCount: parseInt(uc.rows[0].c), hazardCount: parseInt(hc.rows[0].c), completedCount: parseInt(cc.rows[0].c), totalScore: parseInt(sc.rows[0].s) });
  } catch (e) {
    res.json({ userCount: 0, hazardCount: 0, completedCount: 0, totalScore: 0 });
  }
});

// ── 导出隐患数据（含照片ZIP包） ──
app.get('/api/admin/export/hazards', async function(req, res) {
  try {
    var hazardsResult = await pool.query('SELECT * FROM hazards ORDER BY created_at DESC');
    var usersResult = await pool.query('SELECT * FROM users');
    var hazards = hazardsResult.rows;
    var users = usersResult.rows;
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u; });
    var header = ['隐患ID','门店名称','城市','上报人','联系电话','安全类别','危险等级','等级判定方式','法规依据','判定说明','匹配关键词','隐患标题','隐患描述','位置','上报时间','整改状态','整改说明','整改时间','发现积分','整改积分','合计积分','隐患照片','整改照片'];
    var rows = hazards.map(function(h) {
      var u = userMap[h.reporter_id] || {};
      var photoName = h.photo_data ? 'photos/' + h.id + '_report.jpg' : '无';
      var rectPhotoName = h.rectify_photo_data ? 'photos/' + h.id + '_rectify.jpg' : '无';
      return [
        h.id, h.store_name, h.store_city, h.reporter_name, u.phone || '',
        h.category, h.level,
        h.level_confidence ? '智能识别' : '手动选择',
        h.level_law || '', h.level_desc || '', h.level_keywords || '',
        h.title, h.description, h.location,
        h.created_at ? new Date(h.created_at).toLocaleString('zh-CN') : '',
        h.status === 'completed' ? '已整改' : '待整改',
        h.rectify_note || '', h.rectified_at ? new Date(h.rectified_at).toLocaleString('zh-CN') : '',
        h.discovery_score, h.rectify_score, (h.discovery_score || 0) + (h.rectify_score || 0),
        photoName, rectPhotoName
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
    // 添加照片（从数据库解码base64）
    hazards.forEach(function(h) {
      if (h.photo_data) {
        var photoBuffer = Buffer.from(h.photo_data, 'base64');
        archive.append(photoBuffer, { name: 'photos/' + h.id + '_report.jpg' });
      }
      if (h.rectify_photo_data) {
        var rectBuffer = Buffer.from(h.rectify_photo_data, 'base64');
        archive.append(rectBuffer, { name: 'photos/' + h.id + '_rectify.jpg' });
      }
    });
    archive.finalize();
  } catch (e) {
    res.status(500).send('Export error: ' + e.message);
  }
});

// ── 导出CSV - 人员积分 ──
app.get('/api/admin/export/users', async function(req, res) {
  try {
    var usersResult = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    var hazardsResult = await pool.query('SELECT * FROM hazards');
    var users = usersResult.rows;
    var hazards = hazardsResult.rows;
    var header = ['姓名','手机号','城市','门店','岗位','发现隐患','整改完成','总积分','注册时间'];
    var rows = users.map(function(u) {
      var uH = hazards.filter(function(h) { return h.reporter_id === u.id; });
      var score = uH.reduce(function(s, h) { return s + (h.discovery_score || 0) + (h.rectify_score || 0); }, 0);
      return [u.name, u.phone, u.store_city, u.store_name, u.role, uH.length, uH.filter(function(h) { return h.status === 'completed'; }).length, score, u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '']
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
app.get('/api/admin/export/ranking', async function(req, res) {
  try {
    var hazardsResult = await pool.query('SELECT * FROM hazards');
    var hazards = hazardsResult.rows;
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
app.delete('/api/admin/hazards/:id', async function(req, res) {
  try {
    var result = await pool.query('DELETE FROM hazards WHERE id = $1', [req.params.id]);
    if (result.rowCount > 0) {
      res.json({ success: true, message: '隐患已删除' });
    } else {
      res.json({ success: false, message: '隐患不存在' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── 管理员删除用户（同时删除该用户的所有隐患） ──
app.delete('/api/admin/users/:id', async function(req, res) {
  try {
    // CASCADE会自动删除关联的hazards和scores
    var result = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (result.rowCount > 0) {
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
initDB().then(function() {
  app.listen(PORT, '0.0.0.0', function() {
    console.log('========================================');
    console.log('  安全生产月小游戏服务器已启动！');
    console.log('  端口: ' + PORT);
    console.log('  管理员密码: ' + ADMIN_PASSWORD);
    console.log('========================================');
  });
}).catch(function(e) {
  console.error('Database init failed:', e.message);
  process.exit(1);
});
