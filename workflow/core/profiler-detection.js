/**
 * ProjectProfiler Detection Logic
 *
 * Framework, ORM, database, test framework, architecture pattern detection
 * and related detection functions. Extracted from project-profiler.js.
 *
 * @module workflow/core/profiler-detection
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const {
  fileExists,
  dirExists,
  hasExt,
  readFileContent,
  goModContains,
  pomContains,
  gradleContains,
  cargoContains,
  csprojContains,
  pubspecContains,
  composerContains,
  gemfileContains,
  mixExsContains,
  sbtContains,
  gatherConfigContent,
} = require('./profiler-helpers');

// ─── Static Detection Rules ──────────────────────────────────────────────────
// Each rule: { name, category, lang, detect: (root, deps) => boolean }

const FRAMEWORK_RULES = [
  // ── JavaScript / TypeScript Backend ──────────────────────────────────────
  { name: 'NestJS',       category: 'backend',  lang: 'typescript', detect: (_r, d) => !!d['@nestjs/core'] },
  { name: 'Express',      category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['express'] && !d['@nestjs/core'] },
  { name: 'Fastify',      category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['fastify'] },
  { name: 'Koa',          category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['koa'] },
  { name: 'Hono',         category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['hono'] },
  { name: 'Elysia',       category: 'backend',  lang: 'typescript', detect: (_r, d) => !!d['elysia'] },

  // ── JavaScript / TypeScript Frontend ─────────────────────────────────────
  { name: 'Next.js',      category: 'frontend', lang: 'typescript', detect: (_r, d) => !!d['next'] },
  { name: 'Nuxt',         category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['nuxt'] || !!d['nuxt3'] },
  { name: 'React',        category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['react'] && !d['next'] && !d['react-native'] },
  { name: 'Vue',          category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['vue'] && !d['nuxt'] && !d['nuxt3'] },
  { name: 'Svelte',       category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['svelte'] },
  { name: 'Angular',      category: 'frontend', lang: 'typescript', detect: (_r, d) => !!d['@angular/core'] },
  { name: 'SolidJS',      category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['solid-js'] },

  // ── Mobile ──────────────────────────────────────────────────────────────
  { name: 'React Native', category: 'mobile',   lang: 'javascript', detect: (_r, d) => !!d['react-native'] },
  { name: 'Expo',         category: 'mobile',   lang: 'javascript', detect: (_r, d) => !!d['expo'] },
  { name: 'Flutter',      category: 'mobile',   lang: 'dart',       detect: (r) => fileExists(r, 'pubspec.yaml') },
  { name: 'SwiftUI',      category: 'mobile',   lang: 'swift',      detect: (r) => fileExists(r, 'Package.swift') || hasExt(r, '.xcodeproj') },

  // ── Python Backend ──────────────────────────────────────────────────────
  { name: 'Django',       category: 'backend',  lang: 'python',     detect: (r, d) => !!d['django'] || !!d['Django'] || fileExists(r, 'manage.py') },
  { name: 'FastAPI',      category: 'backend',  lang: 'python',     detect: (_r, d) => !!d['fastapi'] },
  { name: 'Flask',        category: 'backend',  lang: 'python',     detect: (_r, d) => !!d['flask'] || !!d['Flask'] },

  // ── Go Backend ──────────────────────────────────────────────────────────
  { name: 'Gin',          category: 'backend',  lang: 'go',         detect: (r) => goModContains(r, 'github.com/gin-gonic/gin') },
  { name: 'Echo',         category: 'backend',  lang: 'go',         detect: (r) => goModContains(r, 'github.com/labstack/echo') },
  { name: 'Fiber',        category: 'backend',  lang: 'go',         detect: (r) => goModContains(r, 'github.com/gofiber/fiber') },

  // ── Java Backend ────────────────────────────────────────────────────────
  { name: 'Spring Boot',  category: 'backend',  lang: 'java',       detect: (r) => pomContains(r, 'spring-boot') || gradleContains(r, 'spring-boot') },
  { name: 'Quarkus',      category: 'backend',  lang: 'java',       detect: (r) => pomContains(r, 'quarkus') || gradleContains(r, 'quarkus') },

  // ── Rust Backend ────────────────────────────────────────────────────────
  { name: 'Actix',        category: 'backend',  lang: 'rust',       detect: (r) => cargoContains(r, 'actix-web') },
  { name: 'Axum',         category: 'backend',  lang: 'rust',       detect: (r) => cargoContains(r, 'axum') },
  { name: 'Rocket',       category: 'backend',  lang: 'rust',       detect: (r) => cargoContains(r, 'rocket') },

  // ── .NET Backend ────────────────────────────────────────────────────────
  { name: 'ASP.NET Core', category: 'backend',  lang: 'csharp',     detect: (r) => csprojContains(r, 'Microsoft.AspNetCore') },
  { name: 'Blazor',       category: 'frontend', lang: 'csharp',     detect: (r) => csprojContains(r, 'Microsoft.AspNetCore.Components') },

  // ── Game Engines ────────────────────────────────────────────────────────
  { name: 'Unity',        category: 'game',     lang: 'csharp',     detect: (r) => fileExists(r, 'Assets') && fileExists(r, 'ProjectSettings') },
  { name: 'Unreal',       category: 'game',     lang: 'cpp',        detect: (r) => hasExt(r, '.uproject') },
  { name: 'Godot',        category: 'game',     lang: 'gdscript',   detect: (r) => fileExists(r, 'project.godot') },

  // ── Desktop ─────────────────────────────────────────────────────────────
  { name: 'Electron',     category: 'desktop',  lang: 'javascript', detect: (_r, d) => !!d['electron'] },
  { name: 'Tauri',        category: 'desktop',  lang: 'rust',       detect: (r) => fileExists(r, 'src-tauri') },

  // ── Kotlin ──────────────────────────────────────────────────────────────
  { name: 'Ktor',         category: 'backend',  lang: 'kotlin',     detect: (r) => gradleContains(r, 'io.ktor') },
  { name: 'Compose Multiplatform', category: 'frontend', lang: 'kotlin', detect: (r) => gradleContains(r, 'compose') && gradleContains(r, 'kotlin') },
  { name: 'Spring Boot (Kotlin)', category: 'backend', lang: 'kotlin', detect: (r) => gradleContains(r, 'spring-boot') && (hasExt(r, '.kt') || gradleContains(r, 'kotlin')) },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { name: 'Laravel',      category: 'backend',  lang: 'php',        detect: (r) => composerContains(r, 'laravel/framework') },
  { name: 'Symfony',      category: 'backend',  lang: 'php',        detect: (r) => composerContains(r, 'symfony/framework-bundle') },
  { name: 'WordPress',    category: 'backend',  lang: 'php',        detect: (r) => fileExists(r, 'wp-config.php') || fileExists(r, 'wp-content') },
  { name: 'CodeIgniter',  category: 'backend',  lang: 'php',        detect: (r) => composerContains(r, 'codeigniter4/framework') },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  { name: 'Rails',        category: 'backend',  lang: 'ruby',       detect: (r) => gemfileContains(r, 'rails') || fileExists(r, 'config/routes.rb') },
  { name: 'Sinatra',      category: 'backend',  lang: 'ruby',       detect: (r) => gemfileContains(r, 'sinatra') },
  { name: 'Hanami',       category: 'backend',  lang: 'ruby',       detect: (r) => gemfileContains(r, 'hanami') },

  // ── Swift ────────────────────────────────────────────────────────────────
  { name: 'Vapor',        category: 'backend',  lang: 'swift',      detect: (r) => readFileContent(r, 'Package.swift').includes('vapor') },

  // ── C / C++ ─────────────────────────────────────────────────────────────
  { name: 'Qt',           category: 'desktop',  lang: 'cpp',        detect: (r) => fileExists(r, 'CMakeLists.txt') && readFileContent(r, 'CMakeLists.txt').includes('Qt') },
  { name: 'CMake Project',category: 'systems',  lang: 'cpp',        detect: (r) => fileExists(r, 'CMakeLists.txt') && !hasExt(r, '.uproject') },

  // ── Scala ───────────────────────────────────────────────────────────────
  { name: 'Play Framework', category: 'backend', lang: 'scala',     detect: (r) => sbtContains(r, 'play') || sbtContains(r, 'playframework') },
  { name: 'Akka',         category: 'backend',  lang: 'scala',      detect: (r) => sbtContains(r, 'akka') },
  { name: 'Spark',        category: 'data',     lang: 'scala',      detect: (r) => sbtContains(r, 'spark') },

  // ── Elixir ──────────────────────────────────────────────────────────────
  { name: 'Phoenix',      category: 'backend',  lang: 'elixir',     detect: (r) => mixExsContains(r, 'phoenix') },
  { name: 'LiveView',     category: 'frontend', lang: 'elixir',     detect: (r) => mixExsContains(r, 'phoenix_live_view') },
];

// ─── Data Layer Detection Rules ───────────────────────────────────────────────

const DATA_LAYER_RULES = [
  // ── JavaScript / TypeScript ─────────────────────────────────────────────
  { name: 'Prisma',       lang: 'javascript', detect: (_r, d) => !!d['prisma'] || !!d['@prisma/client'], configFile: 'prisma/schema.prisma' },
  { name: 'TypeORM',      lang: 'javascript', detect: (_r, d) => !!d['typeorm'], configFile: 'ormconfig.json' },
  { name: 'Drizzle',      lang: 'javascript', detect: (_r, d) => !!d['drizzle-orm'] },
  { name: 'Sequelize',    lang: 'javascript', detect: (_r, d) => !!d['sequelize'] },
  { name: 'Mongoose',     lang: 'javascript', detect: (_r, d) => !!d['mongoose'] },
  { name: 'Knex',         lang: 'javascript', detect: (_r, d) => !!d['knex'] },

  // ── Python ──────────────────────────────────────────────────────────────
  { name: 'Django ORM',   lang: 'python',     detect: (r, d) => !!d['django'] || !!d['Django'] || fileExists(r, 'manage.py') },
  { name: 'SQLAlchemy',   lang: 'python',     detect: (_r, d) => !!d['sqlalchemy'] || !!d['SQLAlchemy'] },
  { name: 'Tortoise ORM', lang: 'python',     detect: (_r, d) => !!d['tortoise-orm'] },

  // ── Go ──────────────────────────────────────────────────────────────────
  { name: 'GORM',         lang: 'go',         detect: (r) => goModContains(r, 'gorm.io/gorm') },
  { name: 'sqlx',         lang: 'go',         detect: (r) => goModContains(r, 'github.com/jmoiron/sqlx') },
  { name: 'Ent',          lang: 'go',         detect: (r) => goModContains(r, 'entgo.io/ent') },

  // ── Java ────────────────────────────────────────────────────────────────
  { name: 'JPA/Hibernate',lang: 'java',       detect: (r) => pomContains(r, 'hibernate') || pomContains(r, 'spring-data-jpa') },
  { name: 'MyBatis',      lang: 'java',       detect: (r) => pomContains(r, 'mybatis') },

  // ── Rust ────────────────────────────────────────────────────────────────
  { name: 'Diesel',       lang: 'rust',       detect: (r) => cargoContains(r, 'diesel') },
  { name: 'SeaORM',       lang: 'rust',       detect: (r) => cargoContains(r, 'sea-orm') },

  // ── .NET ────────────────────────────────────────────────────────────────
  { name: 'Entity Framework', lang: 'csharp', detect: (r) => csprojContains(r, 'Microsoft.EntityFrameworkCore') },
  { name: 'Dapper',       lang: 'csharp',     detect: (r) => csprojContains(r, 'Dapper') },

  // ── Dart / Flutter ──────────────────────────────────────────────────────
  { name: 'Drift',        lang: 'dart',       detect: (r) => pubspecContains(r, 'drift') },
  { name: 'Isar',         lang: 'dart',       detect: (r) => pubspecContains(r, 'isar') },
  { name: 'Hive',         lang: 'dart',       detect: (r) => pubspecContains(r, 'hive') },

  // ── Kotlin ──────────────────────────────────────────────────────────────
  { name: 'Exposed',      lang: 'kotlin',     detect: (r) => gradleContains(r, 'exposed') },
  { name: 'Room',         lang: 'kotlin',     detect: (r) => gradleContains(r, 'room') },
  { name: 'Ktorm',        lang: 'kotlin',     detect: (r) => gradleContains(r, 'ktorm') },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { name: 'Eloquent',     lang: 'php',        detect: (r) => composerContains(r, 'laravel/framework') || composerContains(r, 'illuminate/database') },
  { name: 'Doctrine',     lang: 'php',        detect: (r) => composerContains(r, 'doctrine/orm') },
  { name: 'RedBeanPHP',   lang: 'php',        detect: (r) => composerContains(r, 'gabordemooij/redbean') },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  { name: 'ActiveRecord', lang: 'ruby',       detect: (r) => gemfileContains(r, 'activerecord') || gemfileContains(r, 'rails') },
  { name: 'Sequel',       lang: 'ruby',       detect: (r) => gemfileContains(r, 'sequel') },

  // ── Swift ───────────────────────────────────────────────────────────────
  { name: 'CoreData',     lang: 'swift',      detect: (r) => readFileContent(r, 'Package.swift').includes('CoreData') || hasExt(r, '.xcdatamodeld') },
  { name: 'GRDB',         lang: 'swift',      detect: (r) => readFileContent(r, 'Package.swift').includes('GRDB') },

  // ── C / C++ ─────────────────────────────────────────────────────────────
  { name: 'SQLiteCpp',    lang: 'cpp',        detect: (r) => readFileContent(r, 'CMakeLists.txt').includes('SQLiteCpp') },

  // ── Scala ───────────────────────────────────────────────────────────────
  { name: 'Slick',        lang: 'scala',      detect: (r) => sbtContains(r, 'slick') },
  { name: 'Doobie',       lang: 'scala',      detect: (r) => sbtContains(r, 'doobie') },

  // ── Elixir ──────────────────────────────────────────────────────────────
  { name: 'Ecto',         lang: 'elixir',     detect: (r) => mixExsContains(r, 'ecto') },
];

// ─── Database Detection Indicators ────────────────────────────────────────────

const DATABASE_INDICATORS = [
  { name: 'PostgreSQL',  indicators: ['postgres', 'pg', 'postgresql', 'psycopg'] },
  { name: 'MySQL',       indicators: ['mysql', 'mysql2', 'mariadb'] },
  { name: 'SQLite',      indicators: ['sqlite', 'sqlite3', 'better-sqlite3'] },
  { name: 'MongoDB',     indicators: ['mongodb', 'mongoose', 'mongoclient'] },
  { name: 'Redis',       indicators: ['redis', 'ioredis', 'bull', 'bullmq'] },
  { name: 'DynamoDB',    indicators: ['dynamodb', 'aws-sdk'] },
  { name: 'Elasticsearch', indicators: ['elasticsearch', '@elastic/elasticsearch'] },
  { name: 'Firebase',    indicators: ['firebase', 'firestore'] },
  { name: 'Supabase',    indicators: ['@supabase/supabase-js', 'supabase'] },
];

// ─── Test Framework Detection Rules ───────────────────────────────────────────

const TEST_FRAMEWORK_RULES = [
  { name: 'Jest',         lang: 'javascript', detect: (_r, d) => !!d['jest'] || !!d['@jest/core'] },
  { name: 'Vitest',       lang: 'javascript', detect: (_r, d) => !!d['vitest'] },
  { name: 'Mocha',        lang: 'javascript', detect: (_r, d) => !!d['mocha'] },
  { name: 'Playwright',   lang: 'javascript', detect: (_r, d) => !!d['@playwright/test'] || !!d['playwright'] },
  { name: 'Cypress',      lang: 'javascript', detect: (_r, d) => !!d['cypress'] },
  { name: 'Supertest',    lang: 'javascript', detect: (_r, d) => !!d['supertest'] },
  { name: 'pytest',       lang: 'python',     detect: (_r, d) => !!d['pytest'] },
  { name: 'unittest',     lang: 'python',     detect: (r) => dirExists(r, 'tests') || dirExists(r, 'test') },
  { name: 'JUnit',        lang: 'java',       detect: (r) => pomContains(r, 'junit') || gradleContains(r, 'junit') },
  { name: 'xUnit',        lang: 'csharp',     detect: (r) => csprojContains(r, 'xunit') },
  { name: 'NUnit',        lang: 'csharp',     detect: (r) => csprojContains(r, 'NUnit') },
  { name: 'flutter_test', lang: 'dart',       detect: (r) => pubspecContains(r, 'flutter_test') },
  { name: 'go test',      lang: 'go',         detect: (r) => fileExists(r, 'go.mod') },
  { name: 'cargo test',   lang: 'rust',       detect: (r) => fileExists(r, 'Cargo.toml') },
  { name: 'Kotest',       lang: 'kotlin',     detect: (r) => gradleContains(r, 'kotest') },
  { name: 'PHPUnit',      lang: 'php',        detect: (r) => composerContains(r, 'phpunit') || fileExists(r, 'phpunit.xml') },
  { name: 'Pest',         lang: 'php',        detect: (r) => composerContains(r, 'pestphp/pest') },
  { name: 'RSpec',        lang: 'ruby',       detect: (r) => gemfileContains(r, 'rspec') || dirExists(r, 'spec') },
  { name: 'Minitest',     lang: 'ruby',       detect: (r) => gemfileContains(r, 'minitest') },
  { name: 'XCTest',       lang: 'swift',      detect: (r) => readFileContent(r, 'Package.swift').includes('XCTest') || dirExists(r, 'Tests') },
  { name: 'GoogleTest',   lang: 'cpp',        detect: (r) => readFileContent(r, 'CMakeLists.txt').includes('gtest') || readFileContent(r, 'CMakeLists.txt').includes('GTest') },
  { name: 'Catch2',       lang: 'cpp',        detect: (r) => readFileContent(r, 'CMakeLists.txt').includes('Catch2') },
  { name: 'ScalaTest',    lang: 'scala',      detect: (r) => sbtContains(r, 'scalatest') },
  { name: 'ExUnit',       lang: 'elixir',     detect: (r) => fileExists(r, 'mix.exs') },
];

// ─── Architecture Pattern Rules ───────────────────────────────────────────────

const ARCHITECTURE_PATTERNS = [
  {
    name: 'Clean Architecture',
    confidence: 0,
    dirPatterns: ['domain', 'usecases', 'infrastructure', 'presentation', 'application'],
    minMatch: 3,
  },
  {
    name: 'MVC',
    confidence: 0,
    dirPatterns: ['controllers', 'models', 'views', 'controller', 'model', 'view'],
    minMatch: 2,
  },
  {
    name: 'MVVM',
    confidence: 0,
    dirPatterns: ['viewmodels', 'viewmodel', 'view_models', 'view_model', 'views', 'models'],
    minMatch: 2,
  },
  {
    name: 'Layered (Service-Repository)',
    confidence: 0,
    dirPatterns: ['services', 'repositories', 'entities', 'dtos', 'service', 'repository'],
    minMatch: 2,
  },
  {
    name: 'Feature-based Modules',
    confidence: 0,
    dirPatterns: ['modules', 'features', 'packages'],
    minMatch: 1,
  },
  {
    name: 'Hexagonal (Ports & Adapters)',
    confidence: 0,
    dirPatterns: ['ports', 'adapters', 'domain', 'core'],
    minMatch: 3,
  },
  {
    name: 'Component-based (Unity/Game)',
    confidence: 0,
    dirPatterns: ['Scripts', 'Components', 'Prefabs', 'Scenes', 'GameFramework'],
    minMatch: 2,
  },
];

// ─── Detection Functions ──────────────────────────────────────────────────────

/**
 * Detects frameworks from dependencies and file structure.
 * @param {string} root - Project root path
 * @param {Object} deps - Merged dependencies object
 * @returns {Array} Detected frameworks
 */
function detectFrameworks(root, deps) {
  const detected = [];
  for (const rule of FRAMEWORK_RULES) {
    try {
      if (rule.detect(root, deps)) {
        detected.push({
          name: rule.name,
          category: rule.category,
          lang: rule.lang,
        });
      }
    } catch { /* ignore detection errors */ }
  }
  return detected;
}

/**
 * Detects data layer (ORM/database clients) from dependencies.
 * @param {string} root - Project root path
 * @param {Object} deps - Merged dependencies object
 * @returns {Object} Data layer info
 */
function detectDataLayer(root, deps) {
  const orm = [];
  const configFiles = [];

  for (const rule of DATA_LAYER_RULES) {
    try {
      if (rule.detect(root, deps)) {
        orm.push(rule.name);
        if (rule.configFile) configFiles.push(rule.configFile);
      }
    } catch { /* ignore detection errors */ }
  }

  return { orm: [...new Set(orm)], configFiles };
}

/**
 * Detects databases from dependencies and config files.
 * @param {string} root - Project root path
 * @param {Object} deps - Merged dependencies object
 * @returns {Array} Detected databases
 */
function detectDatabases(root, deps) {
  const databases = [];
  const allContent = gatherConfigContent(root);

  for (const db of DATABASE_INDICATORS) {
    for (const indicator of db.indicators) {
      if (deps[indicator] || allContent.includes(indicator)) {
        databases.push(db.name);
        break;
      }
    }
  }

  return [...new Set(databases)];
}

/**
 * Detects test frameworks from dependencies.
 * @param {string} root - Project root path
 * @param {Object} deps - Merged dependencies object
 * @returns {Array} Detected test frameworks
 */
function detectTestFrameworks(root, deps) {
  const frameworks = [];
  for (const rule of TEST_FRAMEWORK_RULES) {
    try {
      if (rule.detect(root, deps)) {
        frameworks.push(rule.name);
      }
    } catch { /* ignore detection errors */ }
  }
  return frameworks;
}

/**
 * Detects architecture patterns from directory structure.
 * @param {string} root - Project root path
 * @returns {Object} Detected architecture info
 */
function detectArchitecture(root) {
  // Gather all directories
  const dirs = new Set();
  try {
    function walk(dir, depth = 0) {
      if (depth > 3) return; // Limit depth
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor') {
            dirs.add(e.name.toLowerCase());
            walk(path.join(dir, e.name), depth + 1);
          }
        }
      } catch { /* ignore */ }
    }
    walk(root);
  } catch { /* ignore */ }

  // Match patterns
  let bestMatch = null;
  let bestScore = 0;

  for (const pattern of ARCHITECTURE_PATTERNS) {
    let matches = 0;
    for (const p of pattern.dirPatterns) {
      if (dirs.has(p.toLowerCase())) matches++;
    }
    if (matches >= pattern.minMatch && matches > bestScore) {
      bestScore = matches;
      bestMatch = pattern.name;
    }
  }

  // Build layer list from detected dirs
  const layers = [];
  const layerOrder = ['presentation', 'api', 'controllers', 'services', 'domain', 'models', 'repositories', 'infrastructure', 'data', 'core'];
  for (const layer of layerOrder) {
    if (dirs.has(layer)) layers.push(layer);
  }

  return {
    pattern: bestMatch || 'Unknown',
    layers,
    confidence: bestMatch ? Math.min(bestScore / 4, 1) : 0,
  };
}

/**
 * Detects communication patterns (REST, GraphQL, WebSocket, etc).
 * @param {string} root - Project root path
 * @param {Object} deps - Merged dependencies object
 * @returns {Array} Detected patterns
 */
function detectCommunication(root, deps) {
  const patterns = [];
  const addPattern = (p) => { if (!patterns.includes(p)) patterns.push(p); };

  if (deps['eventemitter3'] || deps['eventemitter2'] || deps['mitt'] || deps['rxjs']) {
    addPattern('Event-driven');
  }
  if (deps['bull'] || deps['bullmq'] || deps['amqplib'] || deps['kafkajs']) {
    addPattern('Message Queue');
  }
  if (deps['socket.io'] || deps['ws'] || deps['@nestjs/websockets']) {
    addPattern('WebSocket');
  }
  if (deps['@grpc/grpc-js'] || deps['grpc'] || goModContains(root, 'google.golang.org/grpc')) {
    addPattern('gRPC');
  }
  if (deps['graphql'] || deps['apollo-server'] || deps['@apollo/server'] || deps['type-graphql']) {
    addPattern('GraphQL');
  }
  if (deps['express'] || deps['fastify'] || deps['koa'] || deps['@nestjs/core'] ||
      deps['fastapi'] || deps['flask'] || deps['django'] ||
      deps['laravel/framework'] || deps['symfony/framework-bundle'] ||
      deps['rails'] || deps['sinatra'] || deps['phoenix'] ||
      goModContains(root, 'github.com/gin-gonic/gin') ||
      goModContains(root, 'github.com/labstack/echo') ||
      goModContains(root, 'github.com/gofiber/fiber')) {
    addPattern('REST API');
  }

  return patterns;
}

/**
 * Detects infrastructure (Docker, CI/CD, IaC).
 * @param {string} root - Project root path
 * @returns {Object} Infrastructure info
 */
function detectInfrastructure(root) {
  const infra = {};

  if (fileExists(root, 'Dockerfile') || fileExists(root, 'dockerfile')) {
    infra.containerized = true;
  }
  if (fileExists(root, 'docker-compose.yml') || fileExists(root, 'docker-compose.yaml') || fileExists(root, 'compose.yml')) {
    infra.orchestration = 'docker-compose';
  }
  if (dirExists(root, 'k8s') || dirExists(root, 'kubernetes') || dirExists(root, 'helm')) {
    infra.orchestration = 'Kubernetes';
  }

  if (dirExists(root, '.github/workflows')) infra.ci = 'GitHub Actions';
  else if (fileExists(root, '.gitlab-ci.yml')) infra.ci = 'GitLab CI';
  else if (fileExists(root, 'Jenkinsfile')) infra.ci = 'Jenkins';
  else if (fileExists(root, '.circleci/config.yml')) infra.ci = 'CircleCI';
  else if (fileExists(root, 'azure-pipelines.yml')) infra.ci = 'Azure Pipelines';
  else if (fileExists(root, 'bitbucket-pipelines.yml')) infra.ci = 'Bitbucket Pipelines';

  if (dirExists(root, 'terraform') || hasExt(root, '.tf')) infra.iac = 'Terraform';
  else if (fileExists(root, 'serverless.yml') || fileExists(root, 'serverless.ts')) infra.iac = 'Serverless Framework';
  else if (fileExists(root, 'cdk.json')) infra.iac = 'AWS CDK';
  else if (fileExists(root, 'pulumi.yaml')) infra.iac = 'Pulumi';

  return infra;
}

/**
 * Detects monorepo structure.
 * @param {string} root - Project root path
 * @param {Object} deps - Merged dependencies object
 * @returns {Object} Monorepo info
 */
function detectMonorepo(root, deps) {
  const result = { isMonorepo: false, tool: null, packages: [] };

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) {
        result.isMonorepo = true;
        if (deps['lerna']) result.tool = 'Lerna';
        else if (deps['turbo']) result.tool = 'Turborepo';
        else if (deps['nx']) result.tool = 'Nx';
        else result.tool = 'npm/yarn workspaces';
      }
    } catch { /* ignore */ }
  }

  if (fileExists(root, 'pnpm-workspace.yaml')) {
    result.isMonorepo = true;
    result.tool = result.tool || 'pnpm workspace';
  }

  if (fileExists(root, 'nx.json')) {
    result.isMonorepo = true;
    result.tool = 'Nx';
  }

  if (result.isMonorepo) {
    for (const dir of ['packages', 'apps', 'libs', 'services', 'modules']) {
      if (dirExists(root, dir)) {
        try {
          const dirPath = path.join(root, dir);
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith('.')) {
              result.packages.push(`${dir}/${e.name}`);
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return result;
}

/**
 * Detects API specifications.
 * @param {string} root - Project root path
 * @returns {Array} Detected APIs
 */
function detectAPIs(root) {
  const apis = [];

  for (const f of ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json']) {
    if (fileExists(root, f)) { apis.push('OpenAPI/Swagger'); break; }
  }
  if (dirExists(root, 'docs/api') || dirExists(root, 'api-docs')) {
    if (!apis.includes('OpenAPI/Swagger')) apis.push('API docs');
  }

  for (const f of ['schema.graphql', 'schema.gql']) {
    if (fileExists(root, f) || fileExists(root, `src/${f}`)) { apis.push('GraphQL Schema'); break; }
  }

  if (dirExists(root, 'proto') || dirExists(root, 'protos')) {
    apis.push('gRPC/Protobuf');
  }

  return apis;
}

/**
 * Detects entry points.
 * @param {string} root - Project root path
 * @returns {Array} Detected entry points
 */
function detectEntryPoints(root) {
  const candidates = [
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
    'src/app.ts', 'src/app.js', 'src/server.ts', 'src/server.js',
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'app.ts', 'app.js', 'server.ts', 'server.js',
    'main.py', 'app.py', 'manage.py',
    'main.go', 'cmd/main.go', 'cmd/server/main.go',
    'src/main.rs', 'src/lib.rs',
    'lib/main.dart',
    'Program.cs', 'src/Program.cs',
    'Assets/Scripts/Main.cs', 'Assets/Scripts/GameEntry.cs',
    'index.php', 'public/index.php',
    'config.ru',
  ];

  const entryPoints = [];
  for (const c of candidates) {
    if (fileExists(root, c)) entryPoints.push(c);
  }
  return entryPoints;
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Rule arrays
  FRAMEWORK_RULES,
  DATA_LAYER_RULES,
  DATABASE_INDICATORS,
  TEST_FRAMEWORK_RULES,
  ARCHITECTURE_PATTERNS,

  // Detection functions
  detectFrameworks,
  detectDataLayer,
  detectDatabases,
  detectTestFrameworks,
  detectArchitecture,
  detectCommunication,
  detectInfrastructure,
  detectMonorepo,
  detectAPIs,
  detectEntryPoints,
};
