#!/usr/bin/env node

/**
 * @file add-file-headers.js - 批量为文件添加标准文件头
 * @category Automation
 * 
 * 职责:
 * - 扫描项目文件
 * - 检测缺少文件头的文件
 * - 根据文件类型自动生成合适的文件头
 * - 批量插入文件头
 * 
 * 使用:
 * node scripts/add-file-headers.js --dry-run  # 预览
 * node scripts/add-file-headers.js            # 实际修改
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 获取所有文件
function getAllFiles(dir, extensions = []) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules' && file !== 'dist' && file !== 'build') {
          results = results.concat(getAllFiles(filePath, extensions));
        }
      } else {
        if (extensions.length === 0 || extensions.some(ext => file.endsWith(ext))) {
          results.push(filePath);
        }
      }
    });
  } catch (err) {
    // Skip
  }
  return results;
}

// 检测文件类型和信息
function detectFileInfo(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath);
  
  // 已有文件头
  if (content.includes('[AI]') || content.includes('@file')) {
    return null;
  }
  
  const info = {
    filePath,
    fileName,
    ext,
    category: null,
    route: null,
    i18nModule: null,
    requiresAuth: 'no',
    usedIn: [],
    dependencies: []
  };
  
  // 页面组件
  if (filePath.includes('/pages/') && fileName.endsWith('Page.tsx')) {
    info.category = 'Page';
    
    // 检测路由
    if (content.includes('useNavigate') || content.includes('Link to=')) {
      const routeMatch = content.match(/to=["']([^"']+)["']/);
      if (routeMatch) info.route = routeMatch[1];
    }
    
    // 检测i18n模块
    if (content.includes('useTranslation')) {
      const t = content.match(/t\(['"]([^'"]+)['"]\)/);
      if (t) {
        info.i18nModule = t[1].split('.')[0];
      }
    }
    
    // 检测是否需要认证
    if (content.includes('useAuth') || content.includes('requireAuth')) {
      info.requiresAuth = 'yes';
    }
    
    info.usedIn.push('App.tsx - 路由配置');
  }
  
  // 通用组件
  else if (filePath.includes('/components/') && ext === '.tsx') {
    info.category = 'Component';
  }
  
  // 工具函数
  else if (filePath.includes('/utils/') || filePath.endsWith('api.ts') || filePath.endsWith('config.ts')) {
    info.category = 'Utility';
  }
  
  // 路由
  else if (filePath.includes('/routes/') && ext === '.js') {
    info.category = 'Route';
    const basePath = fileName.replace('.routes.js', '');
    info.basePath = `/api/${basePath}`;
  }
  
  // 控制器
  else if (filePath.includes('/controllers/') && ext === '.js') {
    info.category = 'Controller';
  }
  
  // 模型
  else if (filePath.includes('/models/') && ext === '.js') {
    info.category = 'Model';
    info.collection = fileName.replace('.js', '').toLowerCase() + 's';
  }
  
  // 中间件
  else if (filePath.includes('/middleware/') && ext === '.js') {
    info.category = 'Middleware';
  }
  
  // 服务
  else if (filePath.includes('/services/') && ext === '.js') {
    info.category = 'Service';
  }
  
  return info.category ? info : null;
}

// 生成文件头
function generateHeader(info) {
  const commentStyle = info.ext === '.tsx' || info.ext === '.ts' || info.ext === '.jsx' || info.ext === '.js' ? '/**' : '#';
  
  let header = '';
  
  if (commentStyle === '/**') {
    header += '/**\n';
    header += ` * @file ${info.fileName} - TODO: 添加功能描述\n`;
    header += ` * @category ${info.category}\n`;
    
    if (info.category === 'Page') {
      header += ` * @requires_auth ${info.requiresAuth}\n`;
      if (info.i18nModule) {
        header += ` * @i18n_module ${info.i18nModule}\n`;
      }
      if (info.route) {
        header += ` * @route ${info.route}\n`;
      }
    }
    
    if (info.category === 'Route' && info.basePath) {
      header += ` * @base_path ${info.basePath}\n`;
    }
    
    if (info.category === 'Model' && info.collection) {
      header += ` * @collection ${info.collection}\n`;
    }
    
    header += ` * \n`;
    header += ` * 📖 [AI] 修改前必读: /.ai-instructions.md\n`;
    header += ` * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 相关章节\n`;
    header += ` * \n`;
    header += ` * 职责:\n`;
    header += ` * - TODO: 描述主要职责\n`;
    header += ` * \n`;
    
    if (info.usedIn.length > 0) {
      header += ` * 被使用于:\n`;
      info.usedIn.forEach(u => {
        header += ` * @used_in ${u}\n`;
      });
      header += ` * \n`;
    }
    
    if (info.category === 'Page') {
      header += ` * 必备功能检查:\n`;
      header += ` * ✅ 国际化 (useTranslation)\n`;
      header += ` * ✅ 错误处理 (try-catch + humanizeError)\n`;
      header += ` * ✅ 加载状态 (loading state)\n`;
      header += ` * ✅ 空状态处理\n`;
      header += ` * ✅ 统一UI样式 (Tailwind)\n`;
      header += ` * ✅ 响应式设计\n`;
    }
    
    header += ` */\n\n`;
  }
  
  return header;
}

// 主函数
async function main() {
  log('\n🔧 批量添加文件头...\n', 'cyan');
  
  if (DRY_RUN) {
    log('⚠️  预览模式（不会实际修改文件）\n', 'yellow');
  }
  
  const projectRoot = path.join(__dirname, '..');
  const stats = {
    total: 0,
    processed: 0,
    skipped: 0
  };
  
  // 前端文件
  const clientRoot = path.join(projectRoot, 'client', 'src');
  const clientFiles = getAllFiles(clientRoot, ['.ts', '.tsx']);
  
  for (const file of clientFiles) {
    if (file.includes('vite-env.d.ts') || file.includes('.css')) continue;
    
    stats.total++;
    const info = detectFileInfo(file);
    
    if (!info) {
      stats.skipped++;
      continue;
    }
    
    const header = generateHeader(info);
    const relativePath = path.relative(projectRoot, file);
    
    log(`📄 ${relativePath}`, 'cyan');
    log(`   类型: ${info.category}`, 'yellow');
    
    if (!DRY_RUN) {
      const content = fs.readFileSync(file, 'utf-8');
      const newContent = header + content;
      fs.writeFileSync(file, newContent, 'utf-8');
      log('   ✅ 已添加文件头\n', 'green');
    } else {
      log(`   预览:\n${header}`, 'yellow');
    }
    
    stats.processed++;
  }
  
  // 后端文件
  const serverRoot = path.join(projectRoot, 'server', 'src');
  const serverFiles = getAllFiles(serverRoot, ['.js']);
  
  for (const file of serverFiles) {
    stats.total++;
    const info = detectFileInfo(file);
    
    if (!info) {
      stats.skipped++;
      continue;
    }
    
    const header = generateHeader(info);
    const relativePath = path.relative(projectRoot, file);
    
    log(`📄 ${relativePath}`, 'cyan');
    log(`   类型: ${info.category}`, 'yellow');
    
    if (!DRY_RUN) {
      const content = fs.readFileSync(file, 'utf-8');
      const newContent = header + content;
      fs.writeFileSync(file, newContent, 'utf-8');
      log('   ✅ 已添加文件头\n', 'green');
    } else {
      log(`   预览:\n${header}`, 'yellow');
    }
    
    stats.processed++;
  }
  
  // 统计
  log('\n' + '='.repeat(60), 'cyan');
  log('📊 完成统计', 'cyan');
  log('='.repeat(60) + '\n', 'cyan');
  log(`总计文件: ${stats.total}`, 'cyan');
  log(`✅ 已处理: ${stats.processed}`, 'green');
  log(`⏭️  跳过（已有文件头）: ${stats.skipped}\n`, 'yellow');
  
  if (DRY_RUN) {
    log('💡 运行 node scripts/add-file-headers.js 来实际添加文件头\n', 'yellow');
  } else {
    log('✅ 文件头添加完成！请手动检查并完善 TODO 部分\n', 'green');
    log('📝 后续步骤:', 'cyan');
    log('   1. 检查生成的文件头是否准确', 'cyan');
    log('   2. 完善 TODO 标记的描述', 'cyan');
    log('   3. 添加具体的依赖关系（@uses, @used_in）', 'cyan');
    log('   4. 运行 node scripts/validate-project.js 验证\n', 'cyan');
  }
}

main().catch(err => {
  log(`\n❌ 错误: ${err.message}\n`, 'red');
  console.error(err);
  process.exit(1);
});
