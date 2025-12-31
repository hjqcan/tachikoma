/**
 * Design Task Detector
 *
 * Analyzes task objectives to detect design-related and reference-based (仿站) tasks.
 * Used by Planner to automatically generate appropriate subtasks for UI/design work.
 *
 * @module planner/design-task-detector
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Result of design task analysis
 */
export interface DesignTaskAnalysis {
  /** Whether this is a design/UI related task */
  isDesignTask: boolean;
  /** Whether this is a reference/clone task (仿站) */
  isReferenceTask: boolean;
  /** Name of the product being referenced (e.g., "网易云音乐", "Spotify") */
  referenceProduct?: string;
  /** Detected primary color for the reference product (if known) */
  referenceColor?: string;
  /** Suggested first subtask for reference tasks */
  suggestedFirstSubtask?: string;
  /** Keywords that triggered the detection */
  detectedKeywords: string[];
}

// ============================================================================
// Reference Products Database
// ============================================================================

/**
 * Known products with their visual characteristics
 */
const REFERENCE_PRODUCTS: Record<
  string,
  {
    patterns: RegExp[];
    color: string;
    layoutType: 'sidebar' | 'topnav' | 'dashboard' | 'ecommerce' | 'video';
    keyComponents: string[];
  }
> = {
  '网易云音乐': {
    patterns: [/网易云音乐/i, /netease\s*cloud\s*music/i, /网易云/i],
    color: '#C20C0C',
    layoutType: 'sidebar',
    keyComponents: ['侧边栏导航', '歌单卡片', '播放器栏', '评论区'],
  },
  Spotify: {
    patterns: [/spotify/i],
    color: '#1DB954',
    layoutType: 'sidebar',
    keyComponents: ['sidebar navigation', 'playlist cards', 'player bar', 'browse grid'],
  },
  淘宝: {
    patterns: [/淘宝/i, /taobao/i],
    color: '#FF4400',
    layoutType: 'ecommerce',
    keyComponents: ['商品卡片', '搜索栏', '分类导航', '购物车'],
  },
  'bilibili/B站': {
    patterns: [/bilibili/i, /b站/i, /哔哩哔哩/i],
    color: '#00A1D6',
    layoutType: 'video',
    keyComponents: ['视频卡片', '弹幕', '番剧区', '动态'],
  },
  Netflix: {
    patterns: [/netflix/i, /奈飞/i],
    color: '#E50914',
    layoutType: 'video',
    keyComponents: ['hero banner', 'content rows', 'preview cards', 'profile selector'],
  },
  YouTube: {
    patterns: [/youtube/i, /油管/i],
    color: '#FF0000',
    layoutType: 'video',
    keyComponents: ['video player', 'recommendation sidebar', 'comments', 'subscription feed'],
  },
  微信: {
    patterns: [/微信/i, /wechat/i],
    color: '#07C160',
    layoutType: 'sidebar',
    keyComponents: ['聊天列表', '联系人', '发现页', '朋友圈'],
  },
  GitHub: {
    patterns: [/github/i],
    color: '#24292E',
    layoutType: 'dashboard',
    keyComponents: ['repository list', 'activity feed', 'code viewer', 'issues'],
  },
};

/**
 * Keywords that indicate a design-related task
 */
const DESIGN_KEYWORDS = [
  // Chinese
  '网站', '网页', '前端', '界面', '页面', '组件', '样式', '布局',
  '美化', '设计', '美观', '交互', '响应式', 'UI', 'UX',
  // English
  'website', 'web', 'frontend', 'front-end', 'interface', 'design',
  'page', 'component', 'style', 'layout', 'css', 'html',
  'landing', 'dashboard', 'portal', 'app',
];

/**
 * Keywords that indicate a reference/clone task
 */
const REFERENCE_KEYWORDS = [
  // Chinese
  '仿', '类似', '风格', '像', '克隆', '复刻', '参照', '模仿',
  // English
  'clone', 'similar', 'like', 'style', 'copy', 'replicate', 'mimic',
];

// ============================================================================
// Core Detection Logic
// ============================================================================

/**
 * Analyze a task objective to detect design and reference task characteristics
 *
 * @param objective - The task objective text to analyze
 * @returns Analysis result with detected characteristics
 *
 * @example
 * ```ts
 * const analysis = analyzeDesignTask('创建一个网易云音乐网站');
 * // Returns:
 * // {
 * //   isDesignTask: true,
 * //   isReferenceTask: true,
 * //   referenceProduct: '网易云音乐',
 * //   referenceColor: '#C20C0C',
 * //   suggestedFirstSubtask: 'Analyze 网易云音乐 UI design...',
 * //   detectedKeywords: ['网站', '网易云音乐']
 * // }
 * ```
 */
export function analyzeDesignTask(objective: string): DesignTaskAnalysis {
  const result: DesignTaskAnalysis = {
    isDesignTask: false,
    isReferenceTask: false,
    detectedKeywords: [],
  };

  if (!objective?.trim()) {
    return result;
  }

  const objectiveLower = objective.toLowerCase();

  // 1. Detect design-related keywords
  for (const keyword of DESIGN_KEYWORDS) {
    if (objectiveLower.includes(keyword.toLowerCase())) {
      result.isDesignTask = true;
      result.detectedKeywords.push(keyword);
    }
  }

  // 2. Check for reference keywords
  const hasReferenceKeyword = REFERENCE_KEYWORDS.some((kw) =>
    objectiveLower.includes(kw.toLowerCase())
  );

  // 3. Check for known product references
  for (const [productName, productInfo] of Object.entries(REFERENCE_PRODUCTS)) {
    for (const pattern of productInfo.patterns) {
      if (pattern.test(objective)) {
        result.isDesignTask = true;
        result.isReferenceTask = true;
        result.referenceProduct = productName;
        result.referenceColor = productInfo.color;
        result.detectedKeywords.push(productName);

        // Generate suggested first subtask
        result.suggestedFirstSubtask = generateDesignAnalysisSubtask(
          productName,
          productInfo.color,
          productInfo.layoutType,
          productInfo.keyComponents
        );
        break;
      }
    }
    if (result.referenceProduct) break;
  }

  // 4. If reference keywords found but no known product, still mark as reference task
  if (hasReferenceKeyword && !result.isReferenceTask) {
    // Try to extract product name from context
    const productMatch = extractUnknownProduct(objective);
    if (productMatch) {
      result.isReferenceTask = true;
      result.referenceProduct = productMatch;
      result.suggestedFirstSubtask = generateGenericDesignAnalysisSubtask(productMatch);
    }
  }

  return result;
}

/**
 * Generate a design analysis subtask for a known product
 */
function generateDesignAnalysisSubtask(
  productName: string,
  color: string,
  layoutType: string,
  keyComponents: string[]
): string {
  const componentsStr = keyComponents.slice(0, 3).join(', ');
  return `Analyze ${productName} UI design: identify primary color (${color}), ${layoutType} layout structure, and key components (${componentsStr}). Document design specifications before implementation.`;
}

/**
 * Generate a generic design analysis subtask for unknown products
 */
function generateGenericDesignAnalysisSubtask(productName: string): string {
  return `Analyze ${productName} UI design: research and document the color scheme, layout structure, and key UI components. Extract design specifications to guide implementation.`;
}

/**
 * Try to extract product name from objective when reference keywords are present
 * but no known product is matched
 */
function extractUnknownProduct(objective: string): string | null {
  // Pattern: "仿/类似/像 X 网站/App/风格"
  const patterns = [
    /(?:仿|类似|像)\s*([^\s,，。]+?)(?:网站|app|风格|的)/i,
    /(?:clone|similar to|like)\s+([A-Za-z0-9]+)/i,
    /([A-Za-z]+)\s*(?:style|clone|replica)/i,
  ];

  for (const pattern of patterns) {
    const match = objective.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a task should have design-first subtask ordering
 *
 * @param objective - Task objective
 * @returns true if design analysis should be prioritized
 */
export function shouldPrioritizeDesignAnalysis(objective: string): boolean {
  const analysis = analyzeDesignTask(objective);
  return analysis.isReferenceTask;
}

/**
 * Get recommended constraints for reference tasks
 *
 * @param analysis - Result from analyzeDesignTask
 * @returns Array of constraint strings to add to subtasks
 */
export function getRecommendedConstraints(analysis: DesignTaskAnalysis): string[] {
  const constraints: string[] = [];

  if (analysis.isReferenceTask && analysis.referenceProduct) {
    if (analysis.referenceColor) {
      constraints.push(`Use ${analysis.referenceProduct}'s color scheme (primary: ${analysis.referenceColor})`);
    }
    constraints.push(`Follow ${analysis.referenceProduct} design style and layout patterns`);
    constraints.push('Do NOT use default scaffold/template styling');
    constraints.push('Do NOT keep Vite/CRA default content (logos, counters, example text)');
  }

  return constraints;
}

// ============================================================================
// Export for Testing
// ============================================================================

export const _testing = {
  REFERENCE_PRODUCTS,
  DESIGN_KEYWORDS,
  REFERENCE_KEYWORDS,
  extractUnknownProduct,
};
