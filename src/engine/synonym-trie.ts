/**
 * algo-memory v2.9.0 - Synonym Trie Tree
 * 
 * 将 SYNONYMS 同义词表预编译为 Trie 树，实现 O(query_len) 的同义词展开。
 * 替代原来 O(query_len × syn_count) 的全表遍历。
 * 
 * 结构：
 * - 每个节点：{ char: string, isWordEnd: boolean, word: string|null, synonyms: string[] }
 * - 从任意子串出发，在 Trie 中查找最长匹配词
 * - 命中时返回该词及其所有同义词
 */

import type { Config } from '../types.js';

// ============= 同义词表（保持与 utils.ts 同步）=============
const SYNONYMS: Record<string, string[]> = {
  // 人物关系
  '老婆': ['媳妇', '妻子', '爱人'],
  '老公': ['丈夫'],
  '孩子': ['儿子', '女儿', '娃'],
  // 地点
  '北京': ['帝都', '京城'],
  '上海': ['沪', '魔都'],
  // 动作/状态
  '住': ['居住', '定居', '住在'],
  '吃': ['吃东西', '用餐', '吃饭', '进食'],
  '喝': ['喝水', '喝茶', '喝咖啡'],
  '工作': ['上班', '干活', '办公'],
  '出差': ['商务出行'],
  '讨厌': ['不喜欢', '厌恶', '抵触', '拒绝', '不想'],
  '喜欢': ['爱', '偏爱', '喜好'],
  // 职业
  '老板': ['上司', '领导'],
  // 数字/时间
  '生日': ['出生日期', '哪天生日'],
  // 手机/电脑/设备
  '手机': ['iPhone', '安卓', '智能手机'],
  '电脑': ['计算机', '笔记本', 'Mac'],
  'Mac': ['苹果电脑', 'Apple'],
  'iPhone': ['苹果手机', '苹果'],
  // 设备状态
  '坏': ['碎', '裂', '爆', '损坏', '故障', '坏了'],
  '碎': ['坏', '裂', '爆', '损坏'],
  '崩': ['死机', '蓝屏', '黑屏', '崩溃', '宕机'],
  '死机': ['崩', '蓝屏', '黑屏', '宕机', '卡死'],
  '蓝屏': ['死机', '宕机', '崩'],
  '没电': ['充电', '电量', '电池'],
  // 项目/代码
  '项目': ['proj', 'project'],
  '代码': ['code', '源码', '程序'],
  // 常用表达
  '记住': ['记得', '别忘', '重要'],
  // 时间
  '今天': ['本日', '今日', '近日'],
  '明天': ['次日', '明日'],
  '昨天': ['昨日', '前一天'],
  // 餐饮
  '午饭': ['午餐', '中饭', '中餐'],
  '早餐': ['早饭', '早点'],
  '晚餐': ['晚饭', '晚膳'],
  '宵夜': ['夜宵'],
  // 食物
  '辣': ['麻辣', '川菜', '火锅', '麻辣烫'],
  // ========== 股票金融 ==========
  // 买入操作
  '买': ['买入', '建仓', '开仓', '增持', '加仓', '补仓', '入手'],
  '买入': ['买', '建仓', '开仓', '增持', '加仓', '入手'],
  '建仓': ['买入', '开仓', '买'],
  '加仓': ['增持', '补仓', '买入', '加码'],
  '增持': ['加仓', '买入', '增仓'],
  // 卖出操作
  '卖': ['卖出', '清仓', '平仓', '止损', '割肉', '减仓', '轻仓', '出货'],
  '卖出': ['卖', '清仓', '平仓', '止盈', '收割'],
  '清仓': ['卖出', '全卖', '空仓', '清空'],
  '平仓': ['卖出', '清仓', '了结'],
  '止损': ['割肉', '止亏', '砍仓', '割', '杀跌'],
  '割肉': ['止损', '止亏', '砍仓'],
  '减仓': ['轻仓', '卖出', '降仓'],
  '止盈': ['卖出', '收割', '获利了结'],
  // 做多做空
  '做多': ['看涨', '买入', '多头', '买涨'],
  '做空': ['看跌', '融券', '空头', '卖空'],
  '多头': ['做多', '看涨', '多头头寸'],
  '空头': ['做空', '看跌', '空头头寸'],
  // K线/行情
  '涨停': ['封板', '涨停板', '涨停了', '封涨停'],
  '跌停': ['跌停板', '跌停了', '炸板'],
  '封板': ['涨停', '涨停板', '封死'],
  '炸板': ['跌停', '打开涨停'],
  '暴跌': ['闪崩', '崩盘', '大跌', '狂泻', '血崩'],
  '大涨': ['暴涨', '飙升', '涨停', '疯涨'],
  '震荡': ['波动', '来回', '盘整', '区间'],
  '破发': ['跌破发行价'],
  // 利好利空
  '利好': ['好消息', '利多', '看涨', '超预期'],
  '利空': ['坏消息', '利淡', '看跌', '黑天鹅'],
  '业绩': ['财报', '财报季', '报表', 'EPS'],
  '超预期': ['业绩超预期', '财报超预期', '利好'],
  // 基金
  '基金': ['ETF', 'ETF基金', '公募基金', '私募基金', '份额', '净值'],
  'ETF': ['指数基金', '交易型开放式指数基金'],
  '定投': ['定期定额', '月定投', '周定投'],
  '分红': ['红利', '分红派息', '派息', '股息'],
  '净值': ['基金净值', '单位净值', '累计净值'],
  '赎回': ['卖出', '退出', '撤资'],
  '申购': ['认购', '申购', '认购新股'],
  '打新': ['申购新股', '打新股', '新股申购', 'IPO'],
  'IPO': ['新股', '打新', '上市', 'IPO申购'],
  // 宏观政策
  '美联储': ['FOMC', '美国央行'],
  '加息': ['提息', '升息', '紧缩'],
  '降息': ['减息', '宽松'],
  '降准': ['下调准备金率', '释放流动性', 'MLF'],
  '量化': ['量化宽松', 'QE', '缩表', 'QT'],
  '汇率': ['外汇', '美元指数', '人民币汇率', '破7'],
  '贬值': ['汇率下跌', '走弱', '破位'],
  '升值': ['汇率上涨', '走强'],
  '通胀': ['CPI', '通货膨胀', '物价'],
  'GDP': ['增速', '增长', '经济增速', 'GDP增速'],
  '房价': ['楼市', '房地产', '地产'],
  '大盘': ['股市', '指数', '沪指', '深成', '创业板'],
  '行情': ['走势', '涨跌', '市场', '盘面'],
  // 交易账户
  '爆仓': ['强制平仓', '被平仓', '穿仓', '保证金不足'],
  '杠杆': ['杠杆率', '倍数'],
  '保证金': ['Margin', '担保金', '维持保证金'],
  '做T': ['日内交易', '高抛低吸', 'T+0'],
  // 品牌/公司
  '茅台': ['贵州茅台', '600519'],
  '腾讯': ['腾讯控股', '00700', '港股00700'],
  '宁德': ['宁德时代', '300750'],
  '比亚迪': ['BYD', '002594'],
  '苹果': ['Apple', 'AAPL', '苹果公司'],
  // 补充
  '基准利率': ['央行利率', '政策利率', '利率'],
  '上调': ['加息', '升息', '提高利率'],
  '联邦': ['美联储', 'FOMC', '美国'],
  '准备金率下调': ['降准', '下调准备金率', '存款准备金率'],
  '年化': ['年化收益', '年收益率'],
  '年化收益': ['年化', '年收益率', '年华回报'],
  '收益率': ['回报', '年化', '利息', '收益'],
  '市值': ['股价', '总市值', '公司市值'],
  '蒸发': ['暴跌', '闪崩', '大跌', '血亏', '腰斩'],
  '债基': ['债券基金', '纯债基金'],
  '通胀率': ['通胀', 'CPI'],
  '亏': ['亏损', '亏本', '赔钱', '亏钱', '浮亏'],
};

// ============= Trie 节点 =============
interface TrieNode {
  /** 子节点映射（key = char） */
  children: Map<string, TrieNode>;
  /** 是否为词的结尾 */
  isWordEnd: boolean;
  /** 如果是词结尾，对应的标准词（key in SYNONYMS）*/
  word: string | null;
  /** 该词的所有同义词（含标准词本身）*/
  synonyms: string[];
}

// ============= SynonymTrie =============
export class SynonymTrie {
  private root: TrieNode;
  /** 已建立的同义词集合（用于 O(1) 判断某词是否为已知标准词）*/
  private knownWords: Set<string>;
  /** 反向映射：value → key（用于双向展开）*/
  private reverseMap: Map<string, string>;

  constructor() {
    this.root = { children: new Map(), isWordEnd: false, word: null, synonyms: [] };
    this.knownWords = new Set();
    this.reverseMap = new Map();
    this.build();
  }

  /**
   * 构建 Trie 树
   * 同时建立正向（key → values）和反向（value → key）映射
   */
  private build(): void {
    for (const [key, values] of Object.entries(SYNONYMS)) {
      const allTerms = [key, ...values];
      this.knownWords.add(key);
      this.knownWords.add(key.toUpperCase());

      // 建立反向映射（value → key）
      for (const v of values) {
        this.reverseMap.set(v.toUpperCase(), key);
        this.knownWords.add(v);
        this.knownWords.add(v.toUpperCase());
      }

      // 将所有 term（含 key 和 values）插入 Trie
      for (const term of allTerms) {
        this.insertTerm(term.toUpperCase(), key);
      }
    }
  }

  /** 将一个 term 插入 Trie，关联到标准词 key */
  private insertTerm(term: string, key: string): void {
    let node = this.root;
    for (const char of term) {
      if (!node.children.has(char)) {
        node.children.set(char, { children: new Map(), isWordEnd: false, word: null, synonyms: [] });
      }
      node = node.children.get(char)!;
    }
    // 词结尾：关联标准词
    node.isWordEnd = true;
    node.word = key;
    node.synonyms = [key, ...(SYNONYMS[key] || [])];
  }

  /**
   * 在 text 中查找所有命中 SYNONYMS 的子串
   * 使用贪心最长匹配：从每个位置出发，在 Trie 中找最长匹配词
   * 
   * 时间复杂度：O(text_len × max_word_len)
   * 相比原来 O(text_len × syn_count)，在同义词表固定时 max_word_len << syn_count
   */
  findMatches(text: string): { term: string; standardKey: string; synonyms: string[] }[] {
    const matches: { term: string; standardKey: string; synonyms: string[] }[] = [];
    const upper = text.toUpperCase();
    let i = 0;

    while (i < upper.length) {
      // 从位置 i 开始，在 Trie 中贪心匹配最长词
      let node = this.root;
      let lastMatch: TrieNode | null = null;
      let lastMatchEnd = i; // 记录上次匹配成功的位置（词结尾）

      for (let j = i; j < upper.length; j++) {
        const char = upper[j];
        const child = node.children.get(char);
        if (!child) break;

        node = child;
        if (node.isWordEnd) {
          lastMatch = node;
          lastMatchEnd = j + 1; // 匹配到 j（含）的词
        }
      }

      if (lastMatch && lastMatch.word) {
        matches.push({
          term: upper.substring(i, lastMatchEnd),
          standardKey: lastMatch.word,
          synonyms: lastMatch.synonyms,
        });
        i = lastMatchEnd; // 跳过已匹配的词（贪心，不重叠）
      } else {
        i++;
      }
    }

    return matches;
  }

  /**
   * 判断某词是否为已知的标准词（用于快速跳过已处理词）
   */
  isKnownWord(word: string): boolean {
    return this.knownWords.has(word.toUpperCase());
  }

  /**
   * 获取某标准词的所有同义词
   */
  getSynonyms(standardKey: string): string[] {
    return SYNONYMS[standardKey] || [];
  }
}

// ============= 全局 Trie 单例（延迟初始化）=============
let globalTrie: SynonymTrie | null = null;

export function getSynonymTrie(): SynonymTrie {
  if (!globalTrie) {
    globalTrie = new SynonymTrie();
  }
  return globalTrie;
}

/**
 * 使用 Trie 树进行同义词展开的 tokenize
 * 替代 utils.ts 中的 extractSynonymTokensFromChinese
 * 
 * 策略：
 * 1. 脚本感知切分（中英文分开）
 * 2. 英文段：直接保留
 * 3. 中文段：用 Trie 查找命中词，返回标准词+同义词
 */
export function trieTokenize(text: string): string[] {
  const trie = getSynonymTrie();
  const tokens = new Set<string>();

  // 第一步：脚本感知切分
  const segments: { text: string; lang: 'latin' | 'cjk' }[] = [];
  let current = '';
  let currentScript: 'latin' | 'cjk' | null = null;

  for (const char of text) {
    const isLatin = /[a-zA-Z0-9]/.test(char);
    const isPunct = /[^\p{L}\p{N}\s]/u.test(char);
    if (isPunct) {
      if (current) {
        segments.push({ text: current, lang: currentScript! });
        current = '';
        currentScript = null;
      }
      continue;
    }
    const script: 'latin' | 'cjk' = isLatin ? 'latin' : 'cjk';
    if (currentScript === null) {
      current = char;
      currentScript = script;
    } else if (script === currentScript) {
      current += char;
    } else {
      segments.push({ text: current, lang: currentScript });
      current = char;
      currentScript = script;
    }
  }
  if (current) segments.push({ text: current, lang: currentScript! });

  for (const seg of segments) {
    if (seg.lang === 'latin') {
      const cleaned = seg.text.toLowerCase().replace(/\s+/g, '');
      if (cleaned.length >= 1) tokens.add(cleaned);
    } else {
      // 中文段：用 Trie 查找所有命中词
      const matches = trie.findMatches(seg.text);
      for (const m of matches) {
        tokens.add(m.standardKey);
        for (const syn of m.synonyms) {
          tokens.add(syn);
        }
      }
      // 对于未匹配到的中文片段（2字以上），直接添加（防止漏掉非同义词内容）
      if (matches.length === 0 && seg.text.length >= 2) {
        tokens.add(seg.text);
      }
    }
  }

  return [...tokens];
}

/**
 * 构建 FTS5 扩展查询（使用 Trie 优化的同义词展开）
 */
export function buildTrieFts5Query(query: string): string {
  const tokens = trieTokenize(query);
  if (tokens.length === 0) return query;

  const seen = new Set<string>();
  const allTokens: string[] = [];
  const trieInstance = getSynonymTrie();

  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      allTokens.push(token);
    }
    // 查同义词（用 Trie 的 getSynonyms 代替全表遍历）
    const syns = trieInstance.getSynonyms(token);
    for (const syn of syns) {
      if (!seen.has(syn)) {
        seen.add(syn);
        allTokens.push(syn);
      }
    }
  }

  if (allTokens.length === 0) return query;
  if (allTokens.length === 1) return allTokens[0];

  return allTokens.map(t => `"${t}"`).join(' OR ');
}
