/**
 * Clarification Detector
 *
 * 检测用户输入中缺失的关键信息，生成澄清问题
 * 专门针对 "想法→产品" 场景优化
 */

// =============================================================================
// 类型定义
// =============================================================================

/** 澄清项优先级 */
export type ClarificationPriority = 'required' | 'recommended' | 'optional';

/** 需要澄清的字段类型 */
export type ClarificationField =
  | 'target_platform'       // 目标平台 (web/mobile/desktop/cli)
  | 'tech_stack'            // 技术栈偏好
  | 'scale'                 // 规模 (个人/团队/企业)
  | 'timeline'              // 时间要求
  | 'style'                 // UI 风格
  | 'deployment'            // 部署方式
  | 'data_source'           // 数据来源
  | 'output_format'         // 输出格式
  | 'authentication'        // 认证需求
  | 'integrations';         // 集成需求

/** 单个澄清项 */
export interface ClarificationItem {
  /** 字段类型 */
  field: ClarificationField;
  /** 优先级 */
  priority: ClarificationPriority;
  /** 建议问题 */
  question: string;
  /** 可能的选项 (用于引导用户) */
  options?: string[];
  /** 检测到的部分信息 */
  detected?: string;
}

/** 澄清检测结果 */
export interface ClarificationResult {
  /** 检测到的意图类型 */
  intentType: 'build_app' | 'research' | 'code_task' | 'question' | 'unknown';
  /** 置信度 */
  confidence: number;
  /** 需要澄清的项 */
  missingInfo: ClarificationItem[];
  /** 已检测到的信息 */
  detectedInfo: Record<string, string>;
  /** 是否需要澄清 */
  needsClarification: boolean;
  /** 建议的第一个问题 */
  firstQuestion: string | undefined;
}

// =============================================================================
// 检测模式
// =============================================================================

/** 意图类型检测模式 */
const INTENT_PATTERNS = {
  build_app: [
    /做一个.*(网站|应用|app|系统|平台|工具)/i,
    /帮我(做|开发|创建|搭建).*(网站|应用|app|系统|平台|工具)/i,
    /开发一个/i,
    /创建一个/i,
    /build.*(app|website|system|tool)/i,
    /create.*(app|website|system|tool)/i,
    /make.*(app|website|system|tool)/i,
  ],
  research: [
    /研究/i,
    /分析/i,
    /了解/i,
    /调研/i,
    /可行性/i,
    /research/i,
    /analyze/i,
    /investigate/i,
  ],
  code_task: [
    /写.*代码/i,
    /实现.*函数/i,
    /修复.*bug/i,
    /添加.*功能/i,
    /write.*code/i,
    /implement/i,
    /fix.*bug/i,
  ],
  question: [
    /^(什么|怎么|如何|为什么|是否|能不能|可以)/,
    /^(what|how|why|can|is|are|do|does)/i,
    /\?$/,
  ],
};

/** 已包含信息检测模式 */
const INFO_PATTERNS: Record<ClarificationField, RegExp[]> = {
  target_platform: [
    /网站|web|网页/i,
    /手机|移动|mobile|ios|android/i,
    /桌面|desktop|electron/i,
    /命令行|cli|terminal/i,
  ],
  tech_stack: [
    /python|typescript|javascript|java|go|rust/i,
    /react|vue|angular|next\.?js|streamlit|gradio/i,
    /fastapi|flask|django|express|nest\.?js/i,
  ],
  scale: [
    /个人|自己用|练习|学习/i,
    /团队|公司|企业|生产/i,
    /大规模|高并发|分布式/i,
  ],
  timeline: [
    /紧急|今天|明天|这周|尽快/i,
    /下周|这个月|不急/i,
    /urgent|asap|today|tomorrow/i,
  ],
  style: [
    /简约|现代|科技感|专业/i,
    /可爱|卡通|活泼/i,
    /暗色|dark|light|明亮/i,
  ],
  deployment: [
    /docker|容器|kubernetes|k8s/i,
    /vercel|railway|render|heroku/i,
    /本地|localhost|内网/i,
    /云|cloud|aws|azure|gcp/i,
  ],
  data_source: [
    /本地文件|上传|导入/i,
    /api|接口|数据库|mysql|postgres|mongodb/i,
    /爬虫|抓取|crawl|scrape/i,
  ],
  output_format: [
    /pdf|word|excel|csv|json/i,
    /图片|视频|音频|image|video|audio/i,
    /报告|图表|chart|graph/i,
  ],
  authentication: [
    /登录|注册|用户|账号|auth/i,
    /微信|google|github|oauth/i,
    /免登录|公开|匿名/i,
  ],
  integrations: [
    /openai|chatgpt|gpt|claude/i,
    /微信|飞书|钉钉|slack|discord/i,
    /支付|stripe|paypal/i,
  ],
};

// =============================================================================
// ClarificationDetector 类
// =============================================================================

/**
 * 澄清检测器
 *
 * 分析用户输入，检测缺失的关键信息，生成澄清问题
 */
export class ClarificationDetector {
  /**
   * 检测用户输入中需要澄清的信息
   */
  detect(userMessage: string): ClarificationResult {
    const trimmed = userMessage.trim();

    // 1. 检测意图类型
    const intentType = this.detectIntentType(trimmed);

    // 2. 提取已知信息
    const detectedInfo = this.extractDetectedInfo(trimmed);

    // 3. 根据意图类型确定需要的字段
    const requiredFields = this.getRequiredFields(intentType);

    // 4. 找出缺失的信息
    const missingInfo = this.findMissingInfo(requiredFields, detectedInfo, intentType);

    // 5. 生成结果
    const needsClarification = missingInfo.some((item) => item.priority === 'required');

    return {
      intentType,
      confidence: this.calculateConfidence(intentType, detectedInfo),
      missingInfo,
      detectedInfo,
      needsClarification,
      firstQuestion: missingInfo[0]?.question,
    };
  }

  /**
   * 检测意图类型
   */
  private detectIntentType(message: string): ClarificationResult['intentType'] {
    for (const [type, patterns] of Object.entries(INTENT_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          return type as ClarificationResult['intentType'];
        }
      }
    }
    return 'unknown';
  }

  /**
   * 提取已检测到的信息
   */
  private extractDetectedInfo(message: string): Record<string, string> {
    const detected: Record<string, string> = {};

    for (const [field, patterns] of Object.entries(INFO_PATTERNS)) {
      for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
          detected[field] = match[0];
          break;
        }
      }
    }

    return detected;
  }

  /**
   * 根据意图类型获取需要的字段
   */
  private getRequiredFields(
    intentType: ClarificationResult['intentType']
  ): { field: ClarificationField; priority: ClarificationPriority }[] {
    switch (intentType) {
      case 'build_app':
        return [
          { field: 'target_platform', priority: 'required' },
          { field: 'tech_stack', priority: 'recommended' },
          { field: 'style', priority: 'recommended' },
          { field: 'deployment', priority: 'optional' },
          { field: 'authentication', priority: 'optional' },
        ];
      case 'research':
        return [
          { field: 'output_format', priority: 'recommended' },
          { field: 'scale', priority: 'optional' },
        ];
      case 'code_task':
        return [
          { field: 'tech_stack', priority: 'recommended' },
        ];
      default:
        return [];
    }
  }

  /**
   * 找出缺失的信息
   */
  private findMissingInfo(
    requiredFields: { field: ClarificationField; priority: ClarificationPriority }[],
    detectedInfo: Record<string, string>,
    intentType: ClarificationResult['intentType']
  ): ClarificationItem[] {
    const missing: ClarificationItem[] = [];

    for (const { field, priority } of requiredFields) {
      if (!detectedInfo[field]) {
        missing.push({
          field,
          priority,
          question: this.generateQuestion(field, intentType),
          options: this.getFieldOptions(field),
        });
      }
    }

    return missing;
  }

  /**
   * 生成澄清问题
   */
  private generateQuestion(
    field: ClarificationField,
    _intentType: ClarificationResult['intentType']
  ): string {
    const questions: Record<ClarificationField, string> = {
      target_platform: '这个应用是用于网页、手机 App 还是命令行工具？',
      tech_stack: '你有技术栈偏好吗？比如 Python/TypeScript？',
      scale: '这个项目是个人使用还是面向团队/企业？',
      timeline: '项目有时间要求吗？',
      style: '你期望什么样的界面风格？（简约/科技感/活泼等）',
      deployment: '希望如何部署？（本地/Docker/云服务）',
      data_source: '数据从哪里来？（用户上传/API/数据库）',
      output_format: '希望输出什么格式的结果？',
      authentication: '需要用户登录功能吗？',
      integrations: '需要集成哪些第三方服务？（如 OpenAI、支付等）',
    };

    return questions[field] || `关于 ${field}，你有什么具体要求吗？`;
  }

  /**
   * 获取字段选项
   */
  private getFieldOptions(field: ClarificationField): string[] {
    const options: Record<ClarificationField, string[]> = {
      target_platform: ['网页应用', '手机 App', '命令行工具', '桌面应用'],
      tech_stack: ['Python (Streamlit/FastAPI)', 'TypeScript (Next.js)', '让你决定'],
      scale: ['个人/学习', '团队使用', '企业生产'],
      timeline: ['不急，慢慢来', '这周需要', '紧急'],
      style: ['简约现代', '科技感', '活泼可爱', '专业商务'],
      deployment: ['本地运行', 'Docker 容器', '云服务 (Vercel/Railway)'],
      data_source: ['用户上传文件', '调用 API', '连接数据库'],
      output_format: ['网页展示', '下载文件', 'API 返回'],
      authentication: ['不需要登录', '简单登录', '第三方登录'],
      integrations: ['OpenAI/Claude', '微信/飞书', '无特殊要求'],
    };

    return options[field] || [];
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(
    intentType: ClarificationResult['intentType'],
    detectedInfo: Record<string, string>
  ): number {
    if (intentType === 'unknown') return 0.3;

    const infoCount = Object.keys(detectedInfo).length;
    const baseConfidence = intentType === 'build_app' ? 0.6 : 0.7;

    return Math.min(baseConfidence + infoCount * 0.1, 0.95);
  }

  /**
   * 生成综合澄清消息
   */
  generateClarificationMessage(result: ClarificationResult): string {
    if (!result.needsClarification) {
      return '';
    }

    const requiredItems = result.missingInfo.filter((item) => item.priority === 'required');
    const recommendedItems = result.missingInfo.filter((item) => item.priority === 'recommended');

    let message = '为了更好地帮你实现这个想法，我需要确认几个问题：\n\n';

    if (requiredItems.length > 0) {
      message += requiredItems.map((item, i) => `${i + 1}. ${item.question}`).join('\n');
    }

    if (recommendedItems.length > 0 && requiredItems.length < 3) {
      const remaining = Math.min(3 - requiredItems.length, recommendedItems.length);
      const toAdd = recommendedItems.slice(0, remaining);
      message += '\n' + toAdd.map((item, i) => `${requiredItems.length + i + 1}. ${item.question}`).join('\n');
    }

    return message;
  }
}
