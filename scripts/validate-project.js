#!/usr/bin/env node

/**
 * @file validate-project.js - 项目完整性自动化验证脚本
 * @category Automation
 * 
 * 职责:
 * - 检查所有代码文件是否有标准文件头
 * - 验证 PROJECT_STRUCTURE.md 是否与实际文件一致
 * - 检查必备功能是否完整（页面组件）
 * - 生成验证报告
 * 
 * 使用:
 * node scripts/validate-project.js
 * npm run validate
 */

const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
  projectRoot: path.join(__dirname, '..'),
  checkPatterns: {
    client: {
      pages: 'client/src/pages/**/*.tsx',
      components: 'client/src/components/**/*.tsx',
      utils: 'client/src/utils/**/*.ts',
      core: 'client/src/*.{ts,tsx}'
    },
    server: {
      routes: 'server/src/routes/**/*.js',
      controllers: 'server/src/controllers/**/*.js',
      models: 'server/src/models/**/*.js',
      middleware: 'server/src/middleware/**/*.js',
      services: 'server/src/services/**/*.js',
      core: 'server/src/*.js'
    }
  },
  requiredHeaders: {
    all: ['@file', '📖 [AI]', '🔄 [AI]', '@category'],
    page: ['@route', '@i18n_module', '必备功能检查'],
    component: ['@used_in'],
    route: ['@endpoint', '@base_path'],
    model: ['@collection'],
  }
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 递归获取所有文件
function getAllFiles(dir, extensions = []) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        // 跳过 node_modules 和 dist
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
    // 目录不存在或无权限，跳过
  }
  return results;
}

// 检查文件头
function checkFileHeader(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const firstLines = content.split('\n').slice(0, 50).join('\n'); // 只检查前50行
  
  const issues = [];
  
  // 检查基本必需标签
  CONFIG.requiredHeaders.all.forEach(tag => {
    if (!firstLines.includes(tag)) {
      issues.push(`缺少标签: ${tag}`);
    }
  });
  
  // 检查分类特定标签
  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);
  
  if (filePath.includes('/pages/') && basename.endsWith('Page')) {
    CONFIG.requiredHeaders.page.forEach(tag => {
      if (!firstLines.includes(tag)) {
        issues.push(`页面组件缺少: ${tag}`);
      }
    });
  }
  
  if (filePath.includes('/components/') && !basename.endsWith('Page')) {
    if (!firstLines.includes('@used_in') && !firstLines.includes('被使用于')) {
      issues.push('组件缺少: @used_in 使用关系说明');
    }
  }
  
  if (filePath.includes('/routes/')) {
    CONFIG.requiredHeaders.route.forEach(tag => {
      if (!firstLines.includes(tag)) {
        issues.push(`路由文件缺少: ${tag}`);
      }
    });
  }
  
  if (filePath.includes('/models/')) {
    if (!firstLines.includes('@collection') && !firstLines.includes('Schema')) {
      issues.push('模型文件缺少: @collection 或 Schema 说明');
    }
  }
  
  return {
    valid: issues.length === 0,
    issues
  };
}

// 检查页面组件必备功能
function checkPageRequirements(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const issues = [];
  
  // 检查国际化
  if (!content.includes('useTranslation') && !content.includes('t(')) {
    issues.push('❌ 可能缺少国际化: 未找到 useTranslation 或 t()');
  }
  
  // 检查错误处理
  if (!content.includes('try') || !content.includes('catch')) {
    issues.push('❌ 可能缺少错误处理: 未找到 try-catch');
  }
  
  if (!content.includes('humanizeError')) {
    issues.push('⚠️  建议使用 humanizeError 进行错误国际化');
  }
  
  // 检查加载状态
  if (!content.includes('loading') && !content.includes('isLoading')) {
    issues.push('⚠️  可能缺少加载状态管理');
  }
  
  return issues;
}

// 主验证函数
async function validateProject() {
  log('\n🔍 开始项目完整性验证...\n', 'cyan');
  
  const report = {
    totalFiles: 0,
    validFiles: 0,
    filesWithIssues: [],
    missingHeaders: [],
    pageIssues: []
  };
  
  // 检查前端文件
  log('📱 检查前端文件...', 'blue');
  const clientRoot = path.join(CONFIG.projectRoot, 'client', 'src');
  const clientFiles = getAllFiles(clientRoot, ['.ts', '.tsx']);
  
  clientFiles.forEach(file => {
    // 跳过一些特殊文件
    if (file.includes('vite-env.d.ts') || file.includes('.css')) return;
    
    report.totalFiles++;
    const result = checkFileHeader(file);
    const relativePath = path.relative(CONFIG.projectRoot, file);
    
    if (!result.valid) {
      report.filesWithIssues.push({
        file: relativePath,
        issues: result.issues
      });
      if (result.issues.some(i => i.includes('缺少标签'))) {
        report.missingHeaders.push(relativePath);
      }
    } else {
      report.validFiles++;
    }
    
    // 额外检查页面组件
    if (file.includes('/pages/') && path.basename(file).endsWith('Page.tsx')) {
      const pageIssues = checkPageRequirements(file);
      if (pageIssues.length > 0) {
        report.pageIssues.push({
          file: relativePath,
          issues: pageIssues
        });
      }
    }
  });
  
  // 检查后端文件
  log('🖥️  检查后端文件...', 'blue');
  const serverRoot = path.join(CONFIG.projectRoot, 'server', 'src');
  const serverFiles = getAllFiles(serverRoot, ['.js']);
  
  serverFiles.forEach(file => {
    report.totalFiles++;
    const result = checkFileHeader(file);
    const relativePath = path.relative(CONFIG.projectRoot, file);
    
    if (!result.valid) {
      report.filesWithIssues.push({
        file: relativePath,
        issues: result.issues
      });
      if (result.issues.some(i => i.includes('缺少标签'))) {
        report.missingHeaders.push(relativePath);
      }
    } else {
      report.validFiles++;
    }
  });
  
  // 生成报告
  log('\n' + '='.repeat(80), 'cyan');
  log('📊 验证报告', 'cyan');
  log('='.repeat(80), 'cyan');
  
  log(`\n总计文件: ${report.totalFiles}`, 'blue');
  log(`✅ 完整文件: ${report.validFiles} (${(report.validFiles/report.totalFiles*100).toFixed(1)}%)`, 'green');
  log(`❌ 有问题的文件: ${report.filesWithIssues.length}`, 'red');
  log(`⚠️  缺少文件头: ${report.missingHeaders.length}`, 'yellow');
  
  // 详细问题列表
  if (report.missingHeaders.length > 0) {
    log('\n🚨 以下文件缺少标准文件头（优先修复）:', 'red');
    report.missingHeaders.slice(0, 20).forEach(file => {
      log(`   - ${file}`, 'red');
    });
    if (report.missingHeaders.length > 20) {
      log(`   ... 还有 ${report.missingHeaders.length - 20} 个文件`, 'red');
    }
  }
  
  if (report.filesWithIssues.length > 0 && report.filesWithIssues.length !== report.missingHeaders.length) {
    log('\n⚠️  以下文件有不完整的文件头:', 'yellow');
    report.filesWithIssues
      .filter(item => !report.missingHeaders.includes(item.file))
      .slice(0, 10)
      .forEach(item => {
        log(`   📄 ${item.file}`, 'yellow');
        item.issues.forEach(issue => {
          log(`      - ${issue}`, 'yellow');
        });
      });
  }
  
  if (report.pageIssues.length > 0) {
    log('\n📋 页面组件功能检查:', 'yellow');
    report.pageIssues.slice(0, 10).forEach(item => {
      log(`   📄 ${item.file}`, 'yellow');
      item.issues.forEach(issue => {
        log(`      ${issue}`, 'yellow');
      });
    });
  }
  
  // 检查文档同步
  log('\n📚 检查文档同步状态...', 'blue');
  const structureDoc = path.join(CONFIG.projectRoot, 'PROJECT_STRUCTURE.md');
  const aiInstructions = path.join(CONFIG.projectRoot, '.ai-instructions.md');
  
  if (!fs.existsSync(structureDoc)) {
    log('   ❌ PROJECT_STRUCTURE.md 不存在！', 'red');
  } else {
    log('   ✅ PROJECT_STRUCTURE.md 存在', 'green');
  }
  
  if (!fs.existsSync(aiInstructions)) {
    log('   ❌ .ai-instructions.md 不存在！', 'red');
  } else {
    log('   ✅ .ai-instructions.md 存在', 'green');
  }
  
  // 总结和建议
  log('\n' + '='.repeat(80), 'cyan');
  log('💡 建议:', 'cyan');
  log('='.repeat(80) + '\n', 'cyan');
  
  if (report.missingHeaders.length > 0) {
    log('1. 优先为缺少文件头的文件添加标准注释', 'yellow');
    log('   参考: .ai-file-header-templates.md', 'yellow');
  }
  
  if (report.pageIssues.length > 0) {
    log('2. 检查页面组件是否实现了所有必备功能', 'yellow');
    log('   参考: .ai-instructions.md #新建页面必备功能清单', 'yellow');
  }
  
  if (report.filesWithIssues.length > report.missingHeaders.length) {
    log('3. 完善现有文件头的元数据（@uses, @used_in等）', 'yellow');
  }
  
  const coverage = (report.validFiles / report.totalFiles * 100);
  log(`\n📈 当前覆盖率: ${coverage.toFixed(1)}%`, coverage >= 80 ? 'green' : 'yellow');
  log(`🎯 目标覆盖率: 100%\n`, 'green');
  
  // 返回退出码
  if (coverage < 50) {
    log('⚠️  覆盖率低于50%，需要尽快补充文件头！\n', 'red');
    process.exit(1);
  } else if (coverage < 80) {
    log('⚠️  覆盖率低于80%，建议继续完善文件头\n', 'yellow');
    process.exit(0);
  } else {
    log('✅ 覆盖率良好！继续保持\n', 'green');
    process.exit(0);
  }
}

// 运行验证
if (require.main === module) {
  validateProject().catch(err => {
    log(`\n❌ 验证过程出错: ${err.message}\n`, 'red');
    console.error(err);
    process.exit(1);
  });
}

module.exports = { validateProject, checkFileHeader, checkPageRequirements };
