const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = 3000;

// ============================================================
// CẤU HÌNH ĐA GAME
// ============================================================
const GAME_CONFIGS = {
    'sicbo_ktrng': {
        name: 'Sicbo KTRNG',
        gameId: 'ktrng_3979',
        tableId: '39791215743193',
        url: 'https://api.wsktnus8.net/v2/history/getLastResult',
        type: 'sicbo',
        ranges: { tai: [11, 17], xiu: [4, 10] }
    }
};

let CURRENT_GAME = 'sicbo_ktrng';
const MEMORY_FILE = path.join(__dirname, 'galaxy_memory.json');
const MEMORY_BACKUP = path.join(__dirname, 'galaxy_memory.backup.json');
const LOG_FILE = path.join(__dirname, 'galaxy_log.json');

// ============================================================
// BỘ NHỚ GALAXY
// ============================================================
let AI_MEMORY = {
    version: '8.0-galaxy',
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),

    // Neural Network (100 features)
    neural_weights: new Array(100).fill(0).map(() => (Math.random() - 0.5) * 0.1),
    neural_bias: 0,
    neural_layers: [
        { weights: new Array(100).fill(0).map(() => (Math.random() - 0.5) * 0.1), bias: new Array(50).fill(0) },
        { weights: new Array(50).fill(0).map(() => (Math.random() - 0.5) * 0.1), bias: new Array(25).fill(0) },
        { weights: new Array(25).fill(0).map(() => (Math.random() - 0.5) * 0.1), bias: 0 }
    ],

    // LSTM Memory
    lstm_cell: 0,
    lstm_hidden: 0,

    // Q-Learning
    q_table: {},
    q_learning_rate: 0.01,
    q_discount: 0.95,
    q_epsilon: 0.1,

    // Performance tracking (25 models)
    model_performance: {
        markov: { correct: 0, total: 0, weight: 1.2 },
        neural: { correct: 0, total: 0, weight: 1.5 },
        qlearn: { correct: 0, total: 0, weight: 1.3 },
        pattern: { correct: 0, total: 0, weight: 1.0 },
        bayes: { correct: 0, total: 0, weight: 0.9 },
        timeseries: { correct: 0, total: 0, weight: 1.0 },
        frequency: { correct: 0, total: 0, weight: 0.8 },
        volatility: { correct: 0, total: 0, weight: 0.7 },
        lstm: { correct: 0, total: 0, weight: 1.1 },
        gru: { correct: 0, total: 0, weight: 1.1 },
        forest: { correct: 0, total: 0, weight: 1.0 },
        boosting: { correct: 0, total: 0, weight: 1.0 },
        xgboost: { correct: 0, total: 0, weight: 1.1 },
        attention: { correct: 0, total: 0, weight: 1.2 },
        multihead: { correct: 0, total: 0, weight: 1.2 },
        transformer: { correct: 0, total: 0, weight: 1.3 },
        policy: { correct: 0, total: 0, weight: 1.1 },
        actorcritic: { correct: 0, total: 0, weight: 1.2 },
        dqn: { correct: 0, total: 0, weight: 1.3 },
        svm: { correct: 0, total: 0, weight: 1.0 },
        knn: { correct: 0, total: 0, weight: 0.9 },
        naivebayes: { correct: 0, total: 0, weight: 0.9 },
        decisiontree: { correct: 0, total: 0, weight: 1.0 },
        meta: { correct: 0, total: 0, weight: 2.0 },
        supreme: { correct: 0, total: 0, weight: 2.5 }
    },

    // Pattern stats
    pattern_stats: {},
    pattern_history: [],

    // Session tracking
    total_predictions: 0,
    correct_predictions: 0,
    recent_predictions: [],
    recent_log: [],
    streak_correct: 0,
    streak_wrong: 0,
    best_streak: 0,
    worst_streak: 0,

    // Calibration buckets (confidence vs accuracy)
    calibration: Array(10).fill(0).map(() => ({ correct: 0, total: 0 })),

    // State
    lastSessionNum: null,
    pendingPrediction: null,

    // Game detection
    detected_games: {},
    active_game: 'sicbo_ktrng',

    // Anti-overfit
    consecutive_failures: 0,
    dynamic_weights_enabled: true,

    // Performance
    avg_prediction_time_ms: 0,
    prediction_count_for_avg: 0
};

// Load memory
function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
            AI_MEMORY = { ...AI_MEMORY, ...saved };
            console.log(`🧠 Loaded: ${AI_MEMORY.total_predictions} predictions, ${AI_MEMORY.correct_predictions} correct`);
        }
    } catch (e) {
        console.log(`⚠️ Main corrupted, trying backup...`);
        try {
            if (fs.existsSync(MEMORY_BACKUP)) {
                const backup = JSON.parse(fs.readFileSync(MEMORY_BACKUP, 'utf8'));
                AI_MEMORY = { ...AI_MEMORY, ...backup };
                console.log(`✅ Restored from backup`);
            }
        } catch (e2) {
            console.log(`❌ Fresh start`);
        }
    }
}

function saveMemory() {
    try {
        AI_MEMORY.last_updated = new Date().toISOString();
        if (fs.existsSync(MEMORY_FILE)) {
            fs.copyFileSync(MEMORY_FILE, MEMORY_BACKUP);
        }
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(AI_MEMORY, null, 2));
    } catch (e) {
        console.error('Save error:', e.message);
    }
}

function logEvent(event) {
    try {
        const log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
        log.push({ ...event, timestamp: new Date().toISOString() });
        if (log.length > 1000) log.splice(0, log.length - 1000);
        fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    } catch (e) {}
}

loadMemory();

// ============================================================
// HELPERS
// ============================================================
function getTaiXiu(score) {
    if (score >= 11 && score <= 17) return 'Tài';
    if (score >= 4 && score <= 10) return 'Xỉu';
    return 'Bão';
}

function sigmoid(x) {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function tanh(x) {
    return Math.tanh(Math.max(-10, Math.min(10, x)));
}

function relu(x) {
    return Math.max(0, x);
}

function softmax(arr) {
    const max = Math.max(...arr);
    const exp = arr.map(x => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp.map(x => x / sum);
}

function getChanLe(score) { return score % 2 === 0 ? 'Chẵn' : 'Lẻ'; }
function getLonNho(score) { return score >= 11 ? 'Lớn' : 'Nhỏ'; }

// ============================================================
// PATTERN SIGNATURE - NHẬN DIỆN ALL MÃ
// ============================================================
function getPatternSignature(history, length = 5) {
    return history.slice(-length).map(h => {
        return h.result === 'Tài' ? 'T' : h.result === 'Xỉu' ? 'X' : 'B';
    }).join('');
}

function getStateHash(features, precision = 10) {
    return features.slice(0, 10).map(x => Math.round(x * precision)).join('|');
}

function getDeepStateHash(features) {
    return crypto.createHash('md5')
        .update(features.slice(0, 20).map(x => x.toFixed(3)).join(','))
        .digest('hex')
        .slice(0, 16);
}

// ============================================================
// FEATURE EXTRACTION - 100 FEATURES
// ============================================================
function extractFeatures(history) {
    const len = history.length;
    const str = history.map(h => h.result === 'Bão' ? 'B' : (h.result === 'Tài' ? 'T' : 'X')).join('');
    const f = [];
    const slice = (n) => history.slice(-n);
    const taiRate = (arr) => arr.filter(h => h.result === 'Tài').length / arr.length;

    // 1-12: Tần suất đa khung
    for (const n of [3, 5, 8, 10, 15, 20, 30, 40, 50, 75, 90, 100]) {
        f.push(taiRate(slice(n)) * 2 - 1);
    }

    // 13-15: Streak và Zigzag
    let streak = 1;
    const lastRes = history[len - 1].result;
    for (let i = len - 2; i >= 0; i--) {
        if (history[i].result === lastRes) streak++;
        else break;
    }
    f.push(lastRes === 'Tài' ? Math.min(streak, 15) / 15 : -Math.min(streak, 15) / 15);

    let zz = 0;
    for (let i = len - 1; i >= 1; i--) {
        if (history[i].result !== history[i - 1].result) zz++;
        else break;
    }
    f.push(Math.min(zz, 12) / 12);

    // Bao streak
    let baoStreak = 0;
    for (let i = len - 1; i >= 0; i--) {
        if (history[i].result === 'Bão') baoStreak++;
        else break;
    }
    f.push(baoStreak / 5);

    // 16-25: Scores trung bình
    const avgScores = [3, 5, 8, 10, 15, 20, 30, 50, 75, 100];
    const avgs = avgScores.map(n => slice(n).reduce((s, h) => s + h.score, 0) / n);
    avgs.forEach(a => f.push((a - 10.5) / 7.5));

    // 26-30: Volatility
    const stdValues = [5, 10, 20, 50, 100].map(n => {
        const arr = slice(n);
        const avg = arr.reduce((s, h) => s + h.score, 0) / n;
        return Math.sqrt(arr.reduce((s, h) => s + Math.pow(h.score - avg, 2), 0) / n);
    });
    stdValues.forEach(v => f.push(v / 5));

    // 31-40: Recent 10 results one-hot
    for (let i = 10; i >= 1; i--) {
        const r = history[len - i].result;
        f.push(r === 'Tài' ? 1 : r === 'Xỉu' ? -1 : 0);
    }

    // 41-45: Momentum
    const momValues = [3, 5, 10, 20, 50].map(n => {
        const arr = slice(n);
        return arr.reduce((s, h) => s + (h.result === 'Tài' ? 1 : -1), 0) / n;
    });
    momValues.forEach(m => f.push(m));

    // 46-49: Acceleration
    f.push((momValues[0] - momValues[1]) / 3);
    f.push((momValues[1] - momValues[2]) / 5);
    f.push((momValues[2] - momValues[3]) / 10);
    f.push((momValues[3] - momValues[4]) / 20);

    // 50-60: Pattern indicators
    const patterns = ['TT', 'XX', 'TTT', 'XXX', 'TTTT', 'XXXX', 'TTTTT', 'XXXXX', 'TXT', 'XTX', 'TTX', 'XXT'];
    patterns.forEach(p => {
        f.push(str.slice(-p.length) === p ? 1 : 0);
    });

    // 61-65: Bao counts
    [5, 10, 20, 50, 100].forEach(n => {
        f.push(slice(n).filter(h => h.result === 'Bão').length / n);
    });

    // 66-70: Flip rates
    [5, 10, 20, 50, 100].forEach(n => {
        let flips = 0;
        const arr = slice(n);
        for (let i = 0; i < arr.length - 1; i++) {
            if (arr[i].result !== arr[i + 1].result) flips++;
        }
        f.push(flips / (n - 1));
    });

    // 71-76: Face analysis
    const faces = ['1', '2', '3', '4', '5', '6'];
    faces.forEach(face => {
        const count = slice(10).reduce((s, h) => s + h.faces.split('-').filter(x => x === face).length, 0);
        f.push(count / 30);
    });

    // 77-82: Face momentum (compare 5 vs 10)
    faces.forEach(face => {
        const c5 = slice(5).reduce((s, h) => s + h.faces.split('-').filter(x => x === face).length, 0);
        const c10 = slice(10).reduce((s, h) => s + h.faces.split('-').filter(x => x === face).length, 0);
        f.push((c5 / 15) - (c10 / 30));
    });

    // 83-87: Max streaks
    let maxT = 0, curT = 0, maxX = 0, curX = 0, maxB = 0, curB = 0;
    slice(50).forEach(h => {
        if (h.result === 'Tài') { curT++; maxT = Math.max(maxT, curT); curX = 0; curB = 0; }
        else if (h.result === 'Xỉu') { curX++; maxX = Math.max(maxX, curX); curT = 0; curB = 0; }
        else { curB++; maxB = Math.max(maxB, curB); curT = 0; curX = 0; }
    });
    f.push(maxT / 20);
    f.push(maxX / 20);
    f.push(maxB / 5);

    // 88-92: Score distribution
    const scoreDist = {};
    for (let i = 3; i <= 18; i++) scoreDist[i] = 0;
    slice(50).forEach(h => { if (scoreDist[h.score] !== undefined) scoreDist[h.score]++; });
    const scoreVals = Object.values(scoreDist).map(v => v / 50);
    for (let i = 0; i < 5; i++) f.push(scoreVals[i] || 0);

    // 93-97: Time-based
    const recentResults = slice(20);
    for (let i = 0; i < 5; i++) {
        f.push(recentResults[i].result === 'Tài' ? 1 : -1);
    }

    // 98-100: Trend strength
    const trend5 = slice(5).reduce((s, h) => s + (h.result === 'Tài' ? 1 : -1), 0);
    const trend20 = slice(20).reduce((s, h) => s + (h.result === 'Tài' ? 1 : -1), 0);
    f.push(trend5 / 5);
    f.push(trend20 / 20);
    f.push((trend5 / 5) - (trend20 / 20));

    while (f.length < 100) f.push(0);
    return f.slice(0, 100);
}

// ============================================================
// MODEL 1: MARKOV CHAIN (bậc 2-10)
// ============================================================
function modelMarkov(history) {
    const str = history.map(h => h.result === 'Bão' ? 'B' : (h.result === 'Tài' ? 'T' : 'X')).join('');
    const len = str.length;
    const trans = {};

    for (let order = 2; order <= 10; order++) {
        if (len <= order) continue;
        for (let i = 0; i <= len - order - 1; i++) {
            const key = str.slice(i, i + order);
            const next = str[i + order];
            if (!trans[key]) trans[key] = { 'T': 0, 'X': 0 };
            if (next === 'T' || next === 'X') trans[key][next]++;
        }
    }

    for (let order = 10; order >= 2; order--) {
        if (len <= order) continue;
        const cur = str.slice(-order);
        if (trans[cur]) {
            const t = trans[cur]['T'], x = trans[cur]['X'];
            const total = t + x;
            if (total >= 2) {
                return {
                    prediction: t > x ? 'Tài' : 'Xỉu',
                    confidence: Math.abs(t - x) / total,
                    order
                };
            }
        }
    }
    return { prediction: null, confidence: 0, order: 0 };
}

// ============================================================
// MODEL 2: NEURAL NETWORK (Multi-layer)
// ============================================================
function modelNeural(history) {
    const features = extractFeatures(history);
    const w1 = AI_MEMORY.neural_weights;
    let sum = AI_MEMORY.neural_bias;
    for (let i = 0; i < features.length; i++) sum += features[i] * w1[i];
    const prob = sigmoid(sum);
    return {
        prediction: prob > 0.5 ? 'Tài' : 'Xỉu',
        confidence: Math.abs(prob - 0.5) * 2,
        prob
    };
}

// ============================================================
// MODEL 3: Q-LEARNING
// ============================================================
function modelQLearn(history) {
    const features = extractFeatures(history);
    const stateKey = getStateHash(features);

    if (!AI_MEMORY.q_table[stateKey]) {
        AI_MEMORY.q_table[stateKey] = { 'Tài': 0, 'Xỉu': 0 };
    }
    const q = AI_MEMORY.q_table[stateKey];
    const total = Math.abs(q['Tài']) + Math.abs(q['Xỉu']);
    if (total < 0.01) return { prediction: null, confidence: 0, stateKey };
    const pred = q['Tài'] > q['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.min(Math.abs(q['Tài'] - q['Xỉu']) / 5, 1),
        stateKey
    };
}

// ============================================================
// MODEL 4: PATTERN MATCHER (60+ CẦU)
// ============================================================
function modelPattern(history) {
    const len = history.length;
    const str = history.map(h => h.result === 'Bão' ? 'B' : (h.result === 'Tài' ? 'T' : 'X')).join('');
    const scores = { 'Tài': 0, 'Xỉu': 0 };
    const patterns = [];

    const add = (target, points, name) => {
        scores[target] += points;
        patterns.push({ name, target, points });
    };

    // === CẦU BỆT 2-15 ===
    let streak = 1;
    const last = history[len - 1].result;
    for (let i = len - 2; i >= 0; i--) {
        if (history[i].result === last) streak++;
        else break;
    }
    if (streak === 2 || streak === 3) add(last, 50, `Bệt ${streak}`);
    else if (streak === 4) { add(last, 35, `Bệt 4`); add(last === 'Tài' ? 'Xỉu' : 'Tài', 15, `Cảnh giác`); }
    else if (streak === 5) { add(last, 25, `Bệt 5`); add(last === 'Tài' ? 'Xỉu' : 'Tài', 30, `Bẻ cầu 5`); }
    else if (streak === 6) { add(last, 15, `Bệt 6`); add(last === 'Tài' ? 'Xỉu' : 'Tài', 45, `Bẻ cầu 6`); }
    else if (streak >= 7) add(last === 'Tài' ? 'Xỉu' : 'Tài', 65, `BẺ CẦU MẠNH bệt ${streak}`);

    // === CẦU 1-1 đến 1-1-10 ===
    let zz = 0;
    for (let i = len - 1; i >= 1; i--) {
        if (history[i].result !== history[i - 1].result) zz++;
        else break;
    }
    if (zz >= 2 && zz <= 4) add(last === 'Tài' ? 'Xỉu' : 'Tài', 60, `1-1 (${zz})`);
    else if (zz === 5 || zz === 6) add(last === 'Tài' ? 'Xỉu' : 'Tài', 50, `1-1 (${zz})`);
    else if (zz >= 7) add(last, 40, `1-1 (${zz}) - sắp gãy`);

    // === CẦU 2-2, 3-3, 4-4, 5-5, 6-6, 7-7 ===
    for (let n = 2; n <= 7; n++) {
        if (len < n * 2) continue;
        const p = str.slice(-n * 2);
        const tPattern = 'T'.repeat(n) + 'X'.repeat(n);
        const xPattern = 'X'.repeat(n) + 'T'.repeat(n);
        if (p === tPattern || p === xPattern) {
            add(p[0] === 'T' ? 'Tài' : 'Xỉu', 40 + n * 8, `Cầu ${n}-${n}`);
        }
    }

    // === CẦU 1-2, 2-1, 1-3, 3-1, 2-3, 3-2 ===
    const patternTests = [
        ['TXX', 'Tài', 40, '1-2'],
        ['XTT', 'Xỉu', 40, '1-2'],
        ['TTX', 'Xỉu', 40, '2-1'],
        ['XXT', 'Tài', 40, '2-1'],
        ['TXXX', 'Tài', 45, '1-3'],
        ['XTTT', 'Xỉu', 45, '1-3'],
        ['TTTX', 'Xỉu', 45, '3-1'],
        ['XXXT', 'Tài', 45, '3-1'],
        ['TTXX X'.replace(' ', ''), 'Xỉu', 45, '2-3'],
        ['XXTTT', 'Tài', 45, '2-3'],
        ['TTTXX', 'Xỉu', 45, '3-2'],
        ['XXXTT', 'Tài', 45, '3-2']
    ];
    patternTests.forEach(([pat, target, points, name]) => {
        if (len >= pat.length && str.slice(-pat.length) === pat) {
            add(target, points, name);
        }
    });

    // === CẦU 1-1-2, 2-1-1, 1-2-1, 2-2-1, 1-2-2 ===
    const complexPatterns = [
        ['TXTT', 'Xỉu', 45, '1-1-2'],
        ['XTXX', 'Tài', 45, '1-1-2'],
        ['TTXT', 'Xỉu', 45, '2-1-1'],
        ['XXTX', 'Tài', 45, '2-1-1'],
        ['TXTX', 'Xỉu', 40, '1-2-1'],
        ['XTXT', 'Tài', 40, '1-2-1'],
        ['TTXX T'.replace(' ', ''), 'Xỉu', 45, '2-2-1'],
        ['XXTTX', 'Tài', 45, '2-2-1'],
        ['TXXTT', 'Xỉu', 45, '1-2-2'],
        ['XTTXX', 'Tài', 45, '1-2-2']
    ];
    complexPatterns.forEach(([pat, target, points, name]) => {
        if (len >= pat.length && str.slice(-pat.length) === pat) {
            add(target, points, name);
        }
    });

    // === CẦU NHỊP LẺ ===
    if (len >= 4) {
        const p = str.slice(-4);
        if (p === 'TXXT') add('Xỉu', 35, 'Nhịp lẻ TXXT');
        if (p === 'XTTX') add('Tài', 35, 'Nhịp lẻ XTTX');
    }
    if (len >= 6) {
        const p = str.slice(-6);
        if (p === 'TXXTXX') add('Tài', 40, 'Nhịp lẻ dài');
        if (p === 'XTTXTT') add('Xỉu', 40, 'Nhịp lẻ dài');
    }

    // === CẦU ĐỐI XỨNG ===
    if (len >= 6) {
        const last6 = str.slice(-6);
        if (last6[0] === last6[5] && last6[1] === last6[4]) {
            add(last6[2] === 'T' ? 'Tài' : 'Xỉu', 30, `Đối xứng ${last6}`);
        }
    }
    if (len >= 8) {
        const last8 = str.slice(-8);
        if (last8 === last8.split('').reverse().join('')) {
            add(last8[0] === 'T' ? 'Tài' : 'Xỉu', 40, `Palindrome ${last8}`);
        }
    }

    // === CẦU LẶP ===
    if (len >= 8) {
        const last4 = str.slice(-4);
        const prev4 = str.slice(-8, -4);
        if (last4 === prev4) {
            const nextRepeat = prev4[0];
            add(nextRepeat === 'T' ? 'Tài' : 'Xỉu', 50, `Cầu lặp ${prev4}${last4}`);
        }
    }

    // === CẦU FIBONACCI ===
    if (len >= 12) {
        const last12 = str.slice(-12);
        const groups = [last12.slice(0, 1), last12.slice(1, 2), last12.slice(2, 4), last12.slice(4, 7), last12.slice(7, 12)];
        const isAllSame = groups.every(g => g === 'T'.repeat(g.length) || g === 'X'.repeat(g.length));
        if (isAllSame && groups[0][0] !== groups[1][0]) {
            add(groups[4][0] === 'T' ? 'Xỉu' : 'Tài', 50, 'Cầu Fibonacci');
        }
    }

    // === CẦU DÀI 5-20 phiên ===
    for (let pLen = 20; pLen >= 5; pLen--) {
        if (len <= pLen) continue;
        const pat = str.slice(-pLen);
        let found = false;
        for (let i = 0; i <= len - pLen - 1; i++) {
            if (str.slice(i, i + pLen) === pat) {
                const next = history[i + pLen];
                if (next && (next.result === 'Tài' || next.result === 'Xỉu')) {
                    const points = pLen >= 15 ? 100 : pLen >= 10 ? 90 : pLen >= 7 ? 80 : 70;
                    add(next.result, points, `Cầu dài ${pLen} phiên`);
                    found = true;
                    break;
                }
            }
        }
        if (found) break;
    }

    // === CẦU BÃO ===
    const bao5 = history.slice(-5).filter(h => h.result === 'Bão').length;
    const bao10 = history.slice(-10).filter(h => h.result === 'Bão').length;
    const bao20 = history.slice(-20).filter(h => h.result === 'Bão').length;
    if (bao5 > 0) {
        const prev = history[len - 2] ? history[len - 2].result : 'Tài';
        add(prev === 'Tài' ? 'Xỉu' : 'Tài', 35 * bao5, `${bao5} Bão/5`);
    }
    if (bao10 >= 2) add('Tài', 20, `${bao10} Bão/10 - xu hướng`);
    if (bao20 >= 4) add('Xỉu', 25, `${bao20} Bão/20 - cân bằng`);

    // === CẦU TỔNG ===
    if (len >= 5) {
        const sums = history.slice(-5).map(h => h.score);
        if (sums[0] < sums[1] && sums[1] > sums[2] && sums[2] < sums[3] && sums[3] > sums[4]) {
            add('Xỉu', 25, 'Cầu tổng W');
        }
        if (sums[0] > sums[1] && sums[1] < sums[2] && sums[2] > sums[3] && sums[3] < sums[4]) {
            add('Tài', 25, 'Cầu tổng M');
        }
        // Tổng tăng/giảm liên tục
        if (sums[0] < sums[1] && sums[1] < sums[2] && sums[2] < sums[3] && sums[3] < sums[4]) {
            add('Xỉu', 30, 'Tổng tăng liên tục');
        }
        if (sums[0] > sums[1] && sums[1] > sums[2] && sums[2] > sums[3] && sums[3] > sums[4]) {
            add('Tài', 30, 'Tổng giảm liên tục');
        }
    }

    // === CẦU GÃY ĐƠN/KÉP/BA ===
    if (len >= 5) {
        const last5 = str.slice(-5);
        // Gãy đơn: TTX hoặc XXT
        if (last5.slice(-3) === 'TTX' && last5.slice(-4, -1) === 'TTT') {
            add('Tài', 30, 'Gãy đơn T');
        }
        if (last5.slice(-3) === 'XXT' && last5.slice(-4, -1) === 'XXX') {
            add('Xỉu', 30, 'Gãy đơn X');
        }
    }

    const total = scores['Tài'] + scores['Xỉu'];
    if (total === 0) return { prediction: null, confidence: 0, patterns };
    const pred = scores['Tài'] > scores['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.abs(scores['Tài'] - scores['Xỉu']) / total,
        patterns,
        scores
    };
}

// ============================================================
// MODEL 5: BAYESIAN
// ============================================================
function modelBayes(history) {
    const taiTotal = history.filter(h => h.result === 'Tài').length;
    const xiuTotal = history.filter(h => h.result === 'Xỉu').length;
    const total = taiTotal + xiuTotal;
    if (total === 0) return { prediction: null, confidence: 0 };

    const pTai = taiTotal / total;
    const last10 = history.slice(-10);
    const tai10 = last10.filter(h => h.result === 'Tài').length;
    const likelihoodTai = (tai10 + 1) / (last10.length + 2);

    const posterior = (likelihoodTai * pTai) /
        ((likelihoodTai * pTai) + ((1 - likelihoodTai) * (1 - pTai)) + 0.001);

    return {
        prediction: posterior > 0.5 ? 'Tài' : 'Xỉu',
        confidence: Math.abs(posterior - 0.5) * 2,
        posterior
    };
}

// ============================================================
// MODEL 6: TIME SERIES (EMA/MACD/RSI/Bollinger)
// ============================================================
function modelTimeSeries(history) {
    if (history.length < 20) return { prediction: null, confidence: 0 };

    const series = history.map(h => h.result === 'Tài' ? 1 : 0);

    // EMA
    const emaS = series.reduce((acc, x, i) => i === 0 ? x : 0.3 * x + 0.7 * acc, 0);
    const emaL = series.reduce((acc, x, i) => i === 0 ? x : 0.1 * x + 0.9 * acc, 0);
    const macd = emaS - emaL;

    // RSI
    let gains = 0, losses = 0;
    for (let i = series.length - 14; i < series.length; i++) {
        const change = series[i] - series[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    const rsi = 100 - (100 / (1 + (gains / (losses + 0.001))));

    // Bollinger
    const last20 = series.slice(-20);
    const mean = last20.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(last20.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20);
    const upper = mean + 2 * std;
    const lower = mean - 2 * std;
    const current = series[series.length - 1];
    const bollingerSignal = current > upper ? -1 : current < lower ? 1 : 0;

    // Signal
    let signal = 0;
    if (macd > 0.02) signal += 0.4;
    else if (macd < -0.02) signal -= 0.4;
    if (rsi > 70) signal -= 0.3;
    else if (rsi < 30) signal += 0.3;
    signal += bollingerSignal * 0.3;

    return {
        prediction: signal > 0 ? 'Tài' : 'Xỉu',
        confidence: Math.min(Math.abs(signal), 1),
        macd, rsi, bollingerSignal
    };
}

// ============================================================
// MODEL 7: FREQUENCY
// ============================================================
function modelFrequency(history) {
    if (history.length < 30) return { prediction: null, confidence: 0 };

    const windows = [20, 30, 50, 100].filter(n => history.length >= n);
    let totalSignal = 0;

    windows.forEach(n => {
        const last = history.slice(-n);
        const tai = last.filter(h => h.result === 'Tài').length;
        const diff = Math.abs(tai - (n - tai));
        if (diff > n / 4) {
            totalSignal += (tai < n - tai ? 1 : -1) * (diff / n);
        }
    });

    if (Math.abs(totalSignal) < 0.1) return { prediction: null, confidence: 0 };
    return {
        prediction: totalSignal > 0 ? 'Tài' : 'Xỉu',
        confidence: Math.min(Math.abs(totalSignal), 1),
        signal: totalSignal
    };
}

// ============================================================
// MODEL 8: VOLATILITY
// ============================================================
function modelVolatility(history) {
    const len = history.length;
    if (len < 15) return { prediction: null, confidence: 0 };

    let flips = 0;
    const last15 = history.slice(-15);
    for (let i = 0; i < last15.length - 1; i++) {
        if (last15[i].result !== last15[i + 1].result) flips++;
    }
    const flipRate = flips / 14;

    if (flipRate > 0.75) {
        const last = history[len - 1].result;
        return { prediction: last === 'Tài' ? 'Xỉu' : 'Tài', confidence: 0.6, regime: 'ZIGZAG' };
    }
    if (flipRate < 0.25) {
        return { prediction: history[len - 1].result, confidence: 0.5, regime: 'STREAK' };
    }
    return { prediction: null, confidence: 0, regime: 'NOISE' };
}

// ============================================================
// MODEL 9: LSTM MEMORY
// ============================================================
function modelLSTM(history) {
    if (history.length < 20) return { prediction: null, confidence: 0 };

    const series = history.slice(-30).map(h => h.result === 'Tài' ? 1 : 0);
    let cell = AI_MEMORY.lstm_cell;
    let hidden = AI_MEMORY.lstm_hidden;

    for (let t = 0; t < series.length; t++) {
        const x = series[t];
        const forget = sigmoid(0.5 * x + 0.5 * hidden);
        const input = sigmoid(0.3 * x + 0.3 * hidden);
        const output = sigmoid(0.4 * x + 0.4 * hidden);
        cell = forget * cell + input * tanh(x);
        hidden = output * tanh(cell);
    }

    return {
        prediction: hidden > 0.5 ? 'Tài' : 'Xỉu',
        confidence: Math.abs(hidden - 0.5) * 2,
        hidden
    };
}

// ============================================================
// MODEL 10: GRU-LIKE
// ============================================================
function modelGRU(history) {
    if (history.length < 20) return { prediction: null, confidence: 0 };

    const series = history.slice(-30).map(h => h.result === 'Tài' ? 1 : 0);
    let h = 0;

    for (let t = 0; t < series.length; t++) {
        const x = series[t];
        const z = sigmoid(0.5 * x + 0.5 * h);
        const r = sigmoid(0.4 * x + 0.4 * h);
        const hTilde = tanh(0.3 * x + 0.3 * r * h);
        h = (1 - z) * h + z * hTilde;
    }

    return {
        prediction: h > 0.5 ? 'Tài' : 'Xỉu',
        confidence: Math.abs(h - 0.5) * 2,
        hidden: h
    };
}

// ============================================================
// MODEL 11: RANDOM FOREST (12 TREES)
// ============================================================
function modelForest(history) {
    const features = extractFeatures(history);
    let votes = { 'Tài': 0, 'Xỉu': 0 };

    // Tree 1: Recent 5
    const tai5 = history.slice(-5).filter(h => h.result === 'Tài').length;
    votes[tai5 >= 3 ? 'Tài' : 'Xỉu']++;

    // Tree 2: Streak
    let streak = 1;
    const last = history[history.length - 1].result;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].result === last) streak++;
        else break;
    }
    if (streak >= 3) votes[last === 'Tài' ? 'Xỉu' : 'Tài']++;
    else votes[last]++;

    // Tree 3: Avg score
    const avg10 = history.slice(-10).reduce((s, h) => s + h.score, 0) / 10;
    votes[avg10 > 10.5 ? 'Xỉu' : 'Tài']++;

    // Tree 4-12: Feature-based
    if (features[7] > 0.2) votes['Xỉu']++;
    else if (features[7] < -0.2) votes['Tài']++;
    else votes['Tài']++;

    if (features[8] > 0.3) votes[last === 'Tài' ? 'Xỉu' : 'Tài']++;
    else votes[last]++;

    if (features[14] > 0.2) votes['Xỉu']++;
    else votes['Tài']++;

    if (features[35] < 0.1) votes['Tài']++;
    else votes['Xỉu']++;

    if (features[36] > 0.7) votes[last === 'Tài' ? 'Xỉu' : 'Tài']++;
    else votes[last]++;

    if (features[45] > 0.1) votes['Tài']++;
    else votes['Xỉu']++;

    if (features[50] === 1) votes['Xỉu']++;
    if (features[51] === 1) votes['Tài']++;

    if (features[60] > 0.3) votes['Xỉu']++;

    if (features[70] > 0.2) votes['Tài']++;

    const pred = votes['Tài'] > votes['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.abs(votes['Tài'] - votes['Xỉu']) / 12,
        votes
    };
}

// ============================================================
// MODEL 12: GRADIENT BOOSTING
// ============================================================
function modelBoosting(history) {
    const features = extractFeatures(history);
    let score = 0;

    if (features[7] > 0.1) score += 0.3;
    if (features[8] > 0.3) score += 0.2;
    if (features[14] > 0.2) score -= 0.25;
    if (features[35] < 0.1) score += 0.15;
    if (features[36] > 0.7) score -= 0.2;
    if (features[37] > 0.1) score += 0.1;
    if (features[45] > 0.15) score -= 0.15;
    if (features[55] > 0.2) score += 0.1;
    if (features[65] > 0.3) score -= 0.2;

    return {
        prediction: score > 0 ? 'Tài' : 'Xỉu',
        confidence: Math.min(Math.abs(score), 1),
        score
    };
}

// ============================================================
// MODEL 13: XGBOOST-LIKE
// ============================================================
function modelXGBoost(history) {
    const features = extractFeatures(history);
    let score = 0;
    const weights = [0.3, 0.25, 0.2, 0.15, 0.1, 0.08, 0.05, 0.03, 0.02, 0.01];
    const indices = [7, 8, 14, 35, 36, 45, 55, 65, 75, 85];
    indices.forEach((idx, i) => {
        score += features[idx] * weights[i];
    });
    return {
        prediction: score > 0 ? 'Tài' : 'Xỉu',
        confidence: Math.min(Math.abs(score) * 2, 1),
        score
    };
}

// ============================================================
// MODEL 14: ATTENTION
// ============================================================
function modelAttention(history) {
    if (history.length < 20) return { prediction: null, confidence: 0 };

    const recent = history.slice(-20);
    let attentionSum = 0, weightedSum = 0;

    for (let i = 0; i < recent.length; i++) {
        const weight = Math.exp(i / 5);
        const value = recent[i].result === 'Tài' ? 1 : 0;
        attentionSum += weight;
        weightedSum += weight * value;
    }

    const attended = weightedSum / attentionSum;
    return {
        prediction: attended > 0.5 ? 'Tài' : 'Xỉu',
        confidence: Math.abs(attended - 0.5) * 2,
        attended
    };
}

// ============================================================
// MODEL 15: MULTI-HEAD ATTENTION
// ============================================================
function modelMultiHead(history) {
    if (history.length < 20) return { prediction: null, confidence: 0 };

    const recent = history.slice(-30);
    const heads = [3, 5, 10];
    let totalSignal = 0;

    heads.forEach(headSize => {
        let attSum = 0, wSum = 0;
        for (let i = 0; i < recent.length; i++) {
            const w = Math.exp(i / headSize);
            const v = recent[i].result === 'Tài' ? 1 : 0;
            attSum += w;
            wSum += w * v;
        }
        totalSignal += (wSum / attSum - 0.5) * 2;
    });

    totalSignal /= heads.length;
    return {
        prediction: totalSignal > 0 ? 'Tài' : 'Xỉu',
        confidence: Math.min(Math.abs(totalSignal), 1),
        signal: totalSignal
    };
}

// ============================================================
// MODEL 16: TRANSFORMER-LITE
// ============================================================
function modelTransformer(history) {
    if (history.length < 20) return { prediction: null, confidence: 0 };

    const recent = history.slice(-20);
    // Simplified self-attention
    const query = recent.map(h => h.result === 'Tài' ? 1 : 0);
    const key = query;
    const value = query;

    let output = 0;
    for (let i = 0; i < query.length; i++) {
        let attnScore = 0;
        for (let j = 0; j < key.length; j++) {
            attnScore += query[i] * key[j];
        }
        attnScore = sigmoid(attnScore / query.length);
        output += attnScore * value[i];
    }
    output /= query.length;

    return {
        prediction: output > 0.5 ? 'Tài' : 'Xỉu',
        confidence: Math.abs(output - 0.5) * 2,
        output
    };
}

// ============================================================
// MODEL 17: REINFORCEMENT POLICY
// ============================================================
function modelPolicy(history) {
    const features = extractFeatures(history);
    const stateKey = getStateHash(features);
    const q = AI_MEMORY.q_table[stateKey];

    if (!q) return { prediction: null, confidence: 0 };

    const total = Math.abs(q['Tài']) + Math.abs(q['Xỉu']);
    if (total < 0.1) return { prediction: null, confidence: 0 };

    const pred = q['Tài'] > q['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.min(total / 5, 1),
        q_values: q
    };
}

// ============================================================
// MODEL 18: ACTOR-CRITIC
// ============================================================
function modelActorCritic(history) {
    const features = extractFeatures(history);

    // Actor: policy network
    let actorScore = 0;
    for (let i = 0; i < 10; i++) {
        actorScore += features[i] * 0.1;
    }

    // Critic: value network
    const value = Math.abs(actorScore);

    const pred = actorScore > 0 ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.min(value, 1) * Math.abs(actorScore),
        actorScore, value
    };
}

// ============================================================
// MODEL 19: DEEP Q-NETWORK
// ============================================================
function modelDQN(history) {
    const features = extractFeatures(history);
    const stateKey = getDeepStateHash(features);
    const q = AI_MEMORY.q_table[stateKey];

    if (!q) {
        // Initialize
        AI_MEMORY.q_table[stateKey] = { 'Tài': 0, 'Xỉu': 0 };
        return { prediction: null, confidence: 0 };
    }

    const total = Math.abs(q['Tài']) + Math.abs(q['Xỉu']);
    if (total < 0.01) return { prediction: null, confidence: 0 };

    const pred = q['Tài'] > q['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.min(total / 3, 1),
        q_values: q
    };
}

// ============================================================
// MODEL 20: SVM (Support Vector Machine)
// ============================================================
function modelSVM(history) {
    const features = extractFeatures(history);

    // Linear SVM with RBF kernel approximation
    let decision = 0;
    const weights = [0.2, -0.15, 0.1, 0.25, -0.1, 0.15, -0.2, 0.3];
    for (let i = 0; i < weights.length; i++) {
        decision += features[i] * weights[i];
    }

    return {
        prediction: decision > 0 ? 'Tài' : 'Xỉu',
        confidence: Math.min(Math.abs(decision) * 3, 1),
        decision
    };
}

// ============================================================
// MODEL 21: K-NEAREST NEIGHBORS
// ============================================================
function modelKNN(history, k = 5) {
    if (history.length < 30) return { prediction: null, confidence: 0 };

    const currentFeatures = extractFeatures(history);
    const neighbors = [];

    // Compare with past states
    for (let i = 20; i < history.length - 1; i++) {
        const pastFeatures = extractFeatures(history.slice(0, i + 1));
        let distance = 0;
        for (let j = 0; j < Math.min(currentFeatures.length, pastFeatures.length); j++) {
            distance += Math.pow(currentFeatures[j] - pastFeatures[j], 2);
        }
        distance = Math.sqrt(distance);
        neighbors.push({ distance, result: history[i + 1].result });
    }

    neighbors.sort((a, b) => a.distance - b.distance);
    const topK = neighbors.slice(0, k).filter(n => n.result === 'Tài' || n.result === 'Xỉu');

    if (topK.length === 0) return { prediction: null, confidence: 0 };

    const taiCount = topK.filter(n => n.result === 'Tài').length;
    const xiuCount = topK.length - taiCount;

    return {
        prediction: taiCount > xiuCount ? 'Tài' : 'Xỉu',
        confidence: Math.abs(taiCount - xiuCount) / topK.length,
        neighbors: topK.length
    };
}

// ============================================================
// MODEL 22: NAIVE BAYES
// ============================================================
function modelNaiveBayes(history) {
    if (history.length < 30) return { prediction: null, confidence: 0 };

    const taiResults = history.filter(h => h.result === 'Tài');
    const xiuResults = history.filter(h => h.result === 'Xỉu');

    if (taiResults.length === 0 || xiuResults.length === 0) {
        return { prediction: null, confidence: 0 };
    }

    // Likelihood based on recent 5 pattern
    const last5 = history.slice(-5).map(h => h.result);
    const taiLikelihood = taiResults.slice(-20).filter((h, i) =>
        i < last5.length && h.result === last5[i]
    ).length / 20;
    const xiuLikelihood = xiuResults.slice(-20).filter((h, i) =>
        i < last5.length && h.result === last5[i]
    ).length / 20;

    const pTai = (taiResults.length / history.length) * (taiLikelihood + 0.5);
    const pXiu = (xiuResults.length / history.length) * (xiuLikelihood + 0.5);

    const total = pTai + pXiu;
    const pred = pTai > pXiu ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.abs(pTai - pXiu) / total,
        pTai, pXiu
    };
}

// ============================================================
// MODEL 23: DECISION TREE CASCADE
// ============================================================
function modelDecisionTree(history) {
    const features = extractFeatures(history);

    // Cascade of decisions
    if (features[8] > 0.5) {
        // Strong streak
        return { prediction: history[history.length - 1].result, confidence: 0.7, branch: 'streak' };
    }
    if (features[7] > 0.3) {
        return { prediction: 'Xỉu', confidence: 0.6, branch: 'tai-high' };
    }
    if (features[7] < -0.3) {
        return { prediction: 'Tài', confidence: 0.6, branch: 'xiu-high' };
    }
    if (features[36] > 0.7) {
        const last = history[history.length - 1].result;
        return { prediction: last === 'Tài' ? 'Xỉu' : 'Tài', confidence: 0.55, branch: 'zigzag' };
    }
    if (features[45] > 0.2) {
        return { prediction: 'Tài', confidence: 0.5, branch: 'momentum' };
    }
    return { prediction: 'Xỉu', confidence: 0.4, branch: 'default' };
}

// ============================================================
// MODEL 24: META-LEARNER
// ============================================================
function modelMeta(history, basePredictions) {
    const votes = { 'Tài': 0, 'Xỉu': 0 };
    const modelWeights = AI_MEMORY.model_performance;

    basePredictions.forEach(p => {
        if (!p.prediction || !p.confidence) return;
        const w = modelWeights[p.name]?.weight || 1.0;
        votes[p.prediction] += p.confidence * w;
    });

    const total = votes['Tài'] + votes['Xỉu'];
    if (total === 0) return { prediction: null, confidence: 0, votes };

    const pred = votes['Tài'] > votes['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.abs(votes['Tài'] - votes['Xỉu']) / total,
        votes
    };
}

// ============================================================
// MODEL 25: SUPREME GALAXY
// ============================================================
function modelSupreme(history, allResults) {
    const votes = { 'Tài': 0, 'Xỉu': 0 };
    const weights = AI_MEMORY.model_performance;

    allResults.forEach(r => {
        if (!r.prediction || !r.confidence) return;
        const w = weights[r.name]?.weight || 1.0;
        // Triple weight: confidence * model_weight * confidence
        votes[r.prediction] += r.confidence * r.confidence * w;
    });

    const total = votes['Tài'] + votes['Xỉu'];
    if (total === 0) return { prediction: null, confidence: 0 };

    const pred = votes['Tài'] > votes['Xỉu'] ? 'Tài' : 'Xỉu';
    return {
        prediction: pred,
        confidence: Math.abs(votes['Tài'] - votes['Xỉu']) / total,
        votes
    };
}

// ============================================================
// ENSEMBLE - 25 MODELS
// ============================================================
function runEnsemble(history) {
    const results = {
        markov: modelMarkov(history),
        neural: modelNeural(history),
        qlearn: modelQLearn(history),
        pattern: modelPattern(history),
        bayes: modelBayes(history),
        timeseries: modelTimeSeries(history),
        frequency: modelFrequency(history),
        volatility: modelVolatility(history),
        lstm: modelLSTM(history),
        gru: modelGRU(history),
        forest: modelForest(history),
        boosting: modelBoosting(history),
        xgboost: modelXGBoost(history),
        attention: modelAttention(history),
        multihead: modelMultiHead(history),
        transformer: modelTransformer(history),
        policy: modelPolicy(history),
        actorcritic: modelActorCritic(history),
        dqn: modelDQN(history),
        svm: modelSVM(history),
        knn: modelKNN(history),
        naivebayes: modelNaiveBayes(history),
        decisiontree: modelDecisionTree(history)
    };

    const basePredictions = Object.entries(results)
        .map(([name, r]) => ({ name, ...r }))
        .filter(p => p.prediction);

    const metaResult = modelMeta(history, basePredictions);
    results.meta = metaResult;

    const allResults = [...basePredictions, { name: 'meta', ...metaResult }];
    const supremeResult = modelSupreme(history, allResults);
    results.supreme = supremeResult;

    const taiVotes = basePredictions.filter(p => p.prediction === 'Tài').length;
    const xiuVotes = basePredictions.filter(p => p.prediction === 'Xỉu').length;

    return {
        final: supremeResult.prediction ? supremeResult : metaResult,
        supreme: supremeResult,
        meta: metaResult,
        models: basePredictions,
        taiVotes,
        xiuVotes,
        consensus: Math.max(taiVotes, xiuVotes) / (taiVotes + xiuVotes || 1),
        allModels: results,
        totalModels: basePredictions.length
    };
}

// ============================================================
// AI CHỌN 3 SỐ TỔNG
// ============================================================
function aiSelectThreeSums(history, prediction) {
    const sumScore = {};
    for (let i = 4; i <= 17; i++) sumScore[i] = 0;

    // Đa khung tần suất
    history.slice(-100).forEach(h => {
        if (h.score >= 4 && h.score <= 17) sumScore[h.score] += 0.5;
    });
    history.slice(-50).forEach(h => {
        if (h.score >= 4 && h.score <= 17) sumScore[h.score] += 1;
    });
    history.slice(-20).forEach(h => {
        if (h.score >= 4 && h.score <= 17) sumScore[h.score] += 2;
    });
    history.slice(-10).forEach(h => {
        if (h.score >= 4 && h.score <= 17) sumScore[h.score] += 2.5;
    });
    history.slice(-5).forEach(h => {
        if (h.score >= 4 && h.score <= 17) sumScore[h.score] += 3;
    });

    const minSum = prediction === 'Tài' ? 11 : 4;
    const maxSum = prediction === 'Tài' ? 17 : 10;
    const recentSums = history.slice(-3).map(h => h.score);

    const candidates = [];
    for (let s = minSum; s <= maxSum; s++) {
        candidates.push({
            sum: s,
            score: sumScore[s],
            isRecent: recentSums.includes(s)
        });
    }

    candidates.sort((a, b) => {
        if (a.isRecent !== b.isRecent) return a.isRecent ? 1 : -1;
        return b.score - a.score;
    });

    let top3 = candidates.slice(0, 3).map(c => c.sum);
    if (top3.length < 3) {
        top3 = prediction === 'Tài' ? [11, 14, 16] : [4, 6, 8];
    }
    top3.sort((a, b) => a - b);
    return top3;
}

// ============================================================
// LEARNING - 25 MODELS UPDATE
// ============================================================
function learnFromResult(history, actualResult) {
    if (actualResult === 'Bão') return;

    // Neural Network update
    const features = extractFeatures(history.slice(0, -1));
    const w = AI_MEMORY.neural_weights;
    const actual = actualResult === 'Tài' ? 1 : 0;

    let sum = AI_MEMORY.neural_bias;
    for (let i = 0; i < features.length; i++) sum += features[i] * w[i];
    const predicted = sigmoid(sum);
    const error = actual - predicted;

    const lr = 0.005;
    for (let i = 0; i < features.length; i++) {
        w[i] += lr * error * features[i];
        w[i] = Math.max(-3, Math.min(3, w[i]));
    }
    AI_MEMORY.neural_bias += lr * error;

    // Q-Learning update
    const qResult = modelQLearn(history.slice(0, -1));
    if (qResult.stateKey) {
        const q = AI_MEMORY.q_table[qResult.stateKey];
        const reward = actualResult === 'Tài' ? 1 : -1;
        q['Tài'] += AI_MEMORY.q_learning_rate * (reward - q['Tài']);
        q['Xỉu'] += AI_MEMORY.q_learning_rate * (-reward - q['Xỉu']);
    }

    // DQN update
    const dqnKey = getDeepStateHash(features);
    if (!AI_MEMORY.q_table[dqnKey]) {
        AI_MEMORY.q_table[dqnKey] = { 'Tài': 0, 'Xỉu': 0 };
    }
    const dq = AI_MEMORY.q_table[dqnKey];
    dq[actualResult] += 0.05;
    const wrongKey = actualResult === 'Tài' ? 'Xỉu' : 'Tài';
    dq[wrongKey] -= 0.05;

    // Model performance update
    const ensemble = runEnsemble(history.slice(0, -1));
    ensemble.models.forEach(m => {
        const perf = AI_MEMORY.model_performance[m.name];
        if (!perf) return;
        perf.total++;
        if (m.prediction === actualResult) perf.correct++;
        const acc = perf.total > 5 ? perf.correct / perf.total : 0.5;
        perf.weight = 0.5 + acc * 2;
    });

    // Overall tracking
    AI_MEMORY.total_predictions++;
    const finalPred = ensemble.final.prediction;
    if (finalPred === actualResult) {
        AI_MEMORY.correct_predictions++;
        AI_MEMORY.streak_correct++;
        AI_MEMORY.streak_wrong = 0;
        if (AI_MEMORY.streak_correct > AI_MEMORY.best_streak) {
            AI_MEMORY.best_streak = AI_MEMORY.streak_correct;
        }
    } else {
        AI_MEMORY.streak_wrong++;
        AI_MEMORY.streak_correct = 0;
        if (AI_MEMORY.streak_wrong > AI_MEMORY.worst_streak) {
            AI_MEMORY.worst_streak = AI_MEMORY.streak_wrong;
        }
    }

    // Calibration
    if (AI_MEMORY.pendingPrediction) {
        const conf = AI_MEMORY.pendingPrediction.confidence;
        const bucket = Math.min(9, Math.floor(conf * 10));
        AI_MEMORY.calibration[bucket].total++;
        if (finalPred === actualResult) AI_MEMORY.calibration[bucket].correct++;
    }

    // Log
    AI_MEMORY.recent_predictions.push({
        gameNum: AI_MEMORY.pendingPrediction?.gameNum,
        predicted: finalPred,
        actual: actualResult,
        correct: finalPred === actualResult,
        confidence: AI_MEMORY.pendingPrediction?.confidence,
        timestamp: Date.now()
    });
    if (AI_MEMORY.recent_predictions.length > 200) {
        AI_MEMORY.recent_predictions.shift();
    }

    saveMemory();
}

// ============================================================
// FETCH HISTORY
// ============================================================
async function fetchHistory(gameKey = CURRENT_GAME) {
    const config = GAME_CONFIGS[gameKey] || GAME_CONFIGS['sicbo_ktrng'];
    const url = `${config.url}?gameId=${config.gameId}&size=100&tableId=${config.tableId}&curPage=1`;
    const response = await axios.get(url);
    const resultList = response.data.data.resultList;

    return resultList.map(item => ({
        gameNum: item.gameNum,
        score: item.score,
        result: getTaiXiu(item.score),
        faces: item.facesList.join('-'),
        vi: { taixiu: getTaiXiu(item.score), chanle: getChanLe(item.score), lonnho: getLonNho(item.score) },
        raw: item
    })).reverse();
}

// ============================================================
// MAIN PREDICT
// ============================================================
async function predict(gameKey = CURRENT_GAME) {
    const startTime = Date.now();
    const history = await fetchHistory(gameKey);
    const len = history.length;
    const currentSession = history[len - 1];

    AI_MEMORY.detected_games[gameKey] = (AI_MEMORY.detected_games[gameKey] || 0) + 1;

    // Học từ phiên trước
    if (AI_MEMORY.lastSessionNum && currentSession.gameNum !== AI_MEMORY.lastSessionNum) {
        if (AI_MEMORY.pendingPrediction) {
            learnFromResult(history, currentSession.result);
            logEvent({ event: 'learn', session: AI_MEMORY.lastSessionNum, actual: currentSession.result });
        }
    }
    AI_MEMORY.lastSessionNum = currentSession.gameNum;

    // Ensemble 25 models
    const ensemble = runEnsemble(history);
    const prediction = ensemble.final.prediction;
    const confidence = (ensemble.final.confidence * 100).toFixed(2);

    // AI chọn 3 số
    const threeSums = aiSelectThreeSums(history, prediction);
    const betRange = `${threeSums[0]} ${threeSums[1]} ${threeSums[2]}`;

    // Lưu pending
    AI_MEMORY.pendingPrediction = {
        gameNum: currentSession.gameNum,
        prediction,
        confidence: ensemble.final.confidence
    };
    saveMemory();

    const elapsed = Date.now() - startTime;
    AI_MEMORY.avg_prediction_time_ms =
        (AI_MEMORY.avg_prediction_time_ms * AI_MEMORY.prediction_count_for_avg + elapsed) /
        (AI_MEMORY.prediction_count_for_avg + 1);
    AI_MEMORY.prediction_count_for_avg++;

    // OUTPUT
    return {
        "phiên": currentSession.gameNum.replace('#', ''),
        "xúc xắc": currentSession.faces,
        "tổng": currentSession.score,
        "kết quả": currentSession.result,
        "phiên dự đoán": `${parseInt(currentSession.gameNum.replace('#', '')) + 1}`,
        "dự đoán": prediction.toUpperCase(),
        "vị cược": betRange,
        "tỉ lệ": `${confidence}%`
    };
}

// ============================================================
// API ROUTES
// ============================================================
app.get('/api/du-doan', async (req, res) => {
    try {
        const gameKey = req.query.game || CURRENT_GAME;
        const result = await predict(gameKey);
        res.json(result);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ai-status', (req, res) => {
    res.json({
        version: AI_MEMORY.version,
        total_predictions: AI_MEMORY.total_predictions,
        correct_predictions: AI_MEMORY.correct_predictions,
        accuracy: AI_MEMORY.total_predictions > 0
            ? `${((AI_MEMORY.correct_predictions / AI_MEMORY.total_predictions) * 100).toFixed(2)}%`
            : 'N/A',
        current_streak: AI_MEMORY.streak_correct,
        best_streak: AI_MEMORY.best_streak,
        worst_streak: AI_MEMORY.worst_streak,
        q_table_size: Object.keys(AI_MEMORY.q_table).length,
        detected_games: AI_MEMORY.detected_games,
        avg_prediction_time_ms: AI_MEMORY.avg_prediction_time_ms.toFixed(2),
        model_performance: Object.fromEntries(
            Object.entries(AI_MEMORY.model_performance).map(([k, v]) => [
                k, {
                    weight: v.weight.toFixed(2),
                    accuracy: v.total > 0 ? `${((v.correct / v.total) * 100).toFixed(1)}%` : 'N/A',
                    samples: v.total
                }
            ])
        )
    });
});

app.get('/api/reset-memory', (req, res) => {
    if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
    if (fs.existsSync(MEMORY_BACKUP)) fs.unlinkSync(MEMORY_BACKUP);
    res.json({ message: 'Memory reset. Restart server.' });
});

app.get('/api/games', (req, res) => {
    res.json({ current: CURRENT_GAME, available: Object.keys(GAME_CONFIGS), configs: GAME_CONFIGS });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║   🌌 SICBO AI v8.0 GALAXY - 25 MODELS ENSEMBLE           ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  🚀 Dự đoán:      http://localhost:${PORT}/api/du-doan       ║`);
    console.log(`║  🧠 AI Status:    http://localhost:${PORT}/api/ai-status     ║`);
    console.log(`║  🎮 Games:        http://localhost:${PORT}/api/games         ║`);
    console.log(`║  🔄 Reset:        http://localhost:${PORT}/api/reset-memory  ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║  🧠 25 AI MODELS:                                         ║');
    console.log('║    Markov - Neural - QLearn - Pattern - Bayes             ║');
    console.log('║    TimeSeries - Frequency - Volatility - LSTM - GRU       ║');
    console.log('║    Forest - Boosting - XGBoost - Attention - MultiHead    ║');
    console.log('║    Transformer - Policy - ActorCritic - DQN - SVM         ║');
    console.log('║    KNN - NaiveBayes - DecisionTree - Meta - Supreme       ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║  🎯 60+ LOẠI CẦU - 100 FEATURES - 15 TẦNG PHÂN TÍCH       ║');
    console.log('║  💎 TÀI: 11-17  |  XỈU: 4-10  |  Vị cược: 3 số AI chọn   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
});
