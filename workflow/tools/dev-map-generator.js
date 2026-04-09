/**
 * Dev Map Generator — 项目级索引文件生成器
 * 
 * 职责：扫描项目结构，生成 .workflow/dev-map.md
 * 作用：
 * - 为 PM Agent 提供项目概览
 * - 为 Gate Controller 提供依赖关系图
 * - 为 Task Board 提供模块划分依据
 * 
 * 文章对应：类似 Harness 的 Dev Map，描述项目能力和健康状态
 * 
 * @module workflow/tools/dev-map-generator
 */

'use strict';

const fs = require('fs');
const path = require('path');

class DevMapGenerator {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.devMapPath = path.join(projectRoot, '.workflow', 'dev-map.md');
  }

  /**
   * 生成 Dev Map
   * @param {Object} options - 生成选项
   */
  async generate(options = {}) {
    const projectInfo = await this._collectProjectInfo();
    const devMap = this._buildDevMap(projectInfo);
    
    // 写入文件
    const dir = path.dirname(this.devMapPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.devMapPath, devMap, 'utf-8');
    
    return {
      generated: true,
      path: this.devMapPath,
      sections: ['概览', '模块', '依赖', '入口', '脚本']
    };
  }

  /**
   * 收集项目信息
   */
  async _collectProjectInfo() {
    const info = {
      name: path.basename(this.projectRoot),
      type: this._detectProjectType(),
      structure: this._scanStructure(),
      entryPoints: this._findEntryPoints(),
      dependencies: this._analyzeDependencies(),
      scripts: this._collectScripts(),
      workflowStatus: this._getWorkflowStatus()
    };

    return info;
  }

  _detectProjectType() {
    const files = fs.readdirSync(this.projectRoot);
    
    if (files.includes('package.json')) return { type: 'node', icon: '📦' };
    if (files.includes('requirements.txt') || files.includes('setup.py')) return { type: 'python', icon: '🐍' };
    if (files.includes('pom.xml') || files.includes('build.gradle')) return { type: 'java', icon: '☕' };
    if (files.includes('go.mod')) return { type: 'go', icon: '🐹' };
    if (files.includes('Cargo.toml')) return { type: 'rust', icon: '🦀' };
    
    return { type: 'unknown', icon: '📁' };
  }

  _scanStructure(depth = 2) {
    const structure = [];
    
    const scanDir = (dir, currentDepth) => {
      if (currentDepth > depth) return;
      
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        
        const fullPath = path.join(dir, item.name);
        const relativePath = path.relative(this.projectRoot, fullPath);
        
        if (item.isDirectory()) {
          structure.push({ type: 'dir', path: relativePath });
          if (currentDepth < depth) {
            scanDir(fullPath, currentDepth + 1);
          }
        } else {
          structure.push({ type: 'file', path: relativePath });
        }
      }
    };
    
    scanDir(this.projectRoot, 0);
    return structure;
  }

  _findEntryPoints() {
    const possibleEntries = [
      'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts',
      'index.js', 'main.py', 'app.py', 'src/App.java',
      'cmd/main.go', 'main.go', 'src/lib.rs'
    ];
    
    return possibleEntries
      .map(e => path.join(this.projectRoot, e))
      .filter(p => fs.existsSync(p))
      .map(p => path.relative(this.projectRoot, p));
  }

  _analyzeDependencies() {
    const deps = {
      direct: [],
      dev: [],
      external: []
    };

    // Node.js
    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        deps.direct = Object.keys(pkg.dependencies || {});
        deps.dev = Object.keys(pkg.devDependencies || {});
      } catch (e) {}
    }

    // Python
    const reqPath = path.join(this.projectRoot, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const content = fs.readFileSync(reqPath, 'utf-8');
      deps.direct = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    }

    return deps;
  }

  _collectScripts() {
    const scripts = [];
    
    // package.json scripts
    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts) {
          scripts.push(...Object.entries(pkg.scripts).map(([k, v]) => ({
            name: k,
            command: v,
            source: 'package.json'
          })));
        }
      } catch (e) {}
    }

    // workflow scripts
    const wfScriptsDir = path.join(this.projectRoot, 'workflow', 'scripts');
    if (fs.existsSync(wfScriptsDir)) {
      const files = fs.readdirSync(wfScriptsDir).filter(f => f.endsWith('.js'));
      scripts.push(...files.map(f => ({
        name: f.replace('.js', ''),
        command: `node workflow/scripts/${f}`,
        source: 'workflow'
      })));
    }

    return scripts;
  }

  _getWorkflowStatus() {
    const progressLogPath = path.join(this.projectRoot, 'output', 'workflow-progress.log');
    if (!fs.existsSync(progressLogPath)) {
      return { initialized: false };
    }

    try {
      const content = fs.readFileSync(progressLogPath, 'utf-8');
      const entries = content.trim().split('\n').filter(l => l);
      
      const sessions = entries.filter(e => e.includes('session_start')).length;
      const completions = entries.filter(e => e.includes('session_summary')).length;
      
      return {
        initialized: true,
        totalSessions: sessions,
        completedSessions: completions,
        activeSessions: sessions - completions
      };
    } catch (e) {
      return { initialized: true, error: e.message };
    }
  }

  _buildDevMap(info) {
    const lines = [
      '# Dev Map — 项目开发地图',
      '',
      `> 自动生成于 ${new Date().toISOString()}`,
      `> 项目类型: ${info.type.icon} ${info.type.type}`,
      '',
      '## 📋 项目概览',
      '',
      `- **项目名称**: ${info.name}`,
      `- **项目类型**: ${info.type.type}`,
      `- **入口文件**: ${info.entryPoints.length > 0 ? info.entryPoints.join(', ') : '未检测到'}`,
      ''
    ];

    // 模块结构
    lines.push('## 🗂️ 模块结构', '');
    const dirs = info.structure.filter(s => s.type === 'dir').map(s => s.path);
    if (dirs.length > 0) {
      dirs.slice(0, 20).forEach(d => lines.push(`- ${d}/`));
      if (dirs.length > 20) {
        lines.push(`- ... 还有 ${dirs.length - 20} 个目录`);
      }
    } else {
      lines.push('（无子目录）');
    }
    lines.push('');

    // 依赖
    if (info.dependencies.direct.length > 0 || info.dependencies.dev.length > 0) {
      lines.push('## 📦 依赖关系', '');
      if (info.dependencies.direct.length > 0) {
        lines.push('### 直接依赖');
        info.dependencies.direct.slice(0, 10).forEach(d => lines.push(`- ${d}`));
        if (info.dependencies.direct.length > 10) {
          lines.push(`- ... 还有 ${info.dependencies.direct.length - 10} 个`);
        }
        lines.push('');
      }
      if (info.dependencies.dev.length > 0) {
        lines.push('### 开发依赖');
        info.dependencies.dev.slice(0, 10).forEach(d => lines.push(`- ${d}`));
        if (info.dependencies.dev.length > 10) {
          lines.push(`- ... 还有 ${info.dependencies.dev.length - 10} 个`);
        }
        lines.push('');
      }
    }

    // 可用脚本
    if (info.scripts.length > 0) {
      lines.push('## ⚡ 可用脚本', '');
      lines.push('| 名称 | 命令 | 来源 |');
      lines.push('|------|------|------|');
      info.scripts.slice(0, 15).forEach(s => {
        lines.push(`| ${s.name} | \`${s.command}\` | ${s.source} |`);
      });
      if (info.scripts.length > 15) {
        lines.push(`| ... | 还有 ${info.scripts.length - 15} 个 | |`);
      }
      lines.push('');
    }

    // 工作流状态
    lines.push('## 🔄 工作流状态', '');
    if (info.workflowStatus.initialized) {
      lines.push(`- **总 Session 数**: ${info.workflowStatus.totalSessions || 0}`);
      lines.push(`- **已完成**: ${info.workflowStatus.completedSessions || 0}`);
      lines.push(`- **进行中**: ${info.workflowStatus.activeSessions || 0}`);
    } else {
      lines.push('- 工作流尚未初始化');
      lines.push('- 运行 `node workflow/init-project.js` 初始化');
    }
    lines.push('');

    // PM Agent 快速导航
    lines.push('## 🧭 PM Agent 快速导航', '');
    lines.push('```');
    lines.push('当前支持命令:');
    lines.push('  /wf <requirement>  - 启动新工作流');
    lines.push('  /status            - 查看当前状态');
    lines.push('```');
    lines.push('');

    // 最后更新
    lines.push('---', '');
    lines.push('*此文件由 DevMapGenerator 自动生成*');
    lines.push('*手动修改可能会被覆盖*');

    return lines.join('\n');
  }
}

// CLI 入口
function main() {
  const projectRoot = process.cwd();
  const generator = new DevMapGenerator(projectRoot);
  
  generator.generate()
    .then(result => {
      console.log(`✅ Dev Map 生成成功: ${result.path}`);
      console.log(`   包含章节: ${result.sections.join(', ')}`);
    })
    .catch(err => {
      console.error(`❌ 生成失败: ${err.message}`);
      process.exit(1);
    });
}

// 如果直接运行
if (require.main === module) {
  main();
}

module.exports = { DevMapGenerator };
