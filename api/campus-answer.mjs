import { KNOWLEDGE_BASE } from './_knowledge-base.mjs';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

const SYSTEM_PROMPT = `你是中国计量大学（中量大）校园问答助手。请用清晰、简洁的中文回答。
你只回答中国计量大学相关校园问题，不回答与学校无关的问题。不要编造学校实时通知、电话号码、政策、校历、办事入口或具体开放时间；不确定时明确说明，并建议用户到中国计量大学官网 https://www.cjlu.edu.cn/ 或本科招生网 https://zs.cjlu.edu.cn/ 核实。涉及安全、医疗、法律、财务等重要事项时，提醒用户咨询相关专业部门。`;

const OFF_TOPIC_REPLY = '抱歉，我只回答与中国计量大学相关的校园问题，例如校园生活、校区位置、招生、教务和学校概况。';
const CAMPUS_TERMS = ['中国计量大学','中量大','cjlu','量大','学校','校园','校区','校门','南门','北门','东门','西门','南大门','北大门','东大门','西大门','教学楼','教学区','实验楼','行政楼','宿舍楼','学生公寓','学源街','钱塘','招生','教务','本科','研究生','专业','课程','选课','考试','奖学金','学费','宿舍','图书馆','食堂','校园卡','社团','社团生活','校历','校医院','校车','报到','毕业','保研','转专业','就业','实验室','体育馆','操场','校内','进校','校训','录取','寝室','开水','澡堂','快递点','自习室','学院'];
function isCampusQuestion(question) {
  const normalized = question.toLowerCase().replace(/[\s，。？！、,.!?：:；;“”‘’（）()【】\[\]{}\-_\\]+/g, '');
  return CAMPUS_TERMS.some((term) => normalized.includes(term));
}

function findKnowledgeAnswer(question) {
  const normalized = question.toLowerCase().replace(/[\s，。？！、,.!?：:；;“”‘’（）()【】\[\]{}\-_\\]+/g, '');
  let bestAnswer = null;
  let bestScore = 0;
  for (const item of KNOWLEDGE_BASE) {
    const terms = [item.question, ...(Array.isArray(item.keywords) ? item.keywords : [])]
      .filter((term) => typeof term === 'string');
    for (const term of terms) {
      const key = term.toLowerCase().replace(/[\s，。？！、,.!?：:；;“”‘’（）()【】\[\]{}\-_\\]+/g, '');
      if (key.length > bestScore && normalized.includes(key) && typeof item.answer === 'string') {
        bestAnswer = item.answer;
        bestScore = key.length;
      }
    }
  }
  return bestScore >= 2 ? bestAnswer : null;
}

function sendJson(response, status, payload) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json(payload);
}

export default async function handler(request, response) {
  if (request.method === 'GET') {
    return sendJson(response, 200, { ok: true });
  }
  if (request.method !== 'POST') {
    return sendJson(response, 405, { error: '仅支持 POST 请求' });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return sendJson(response, 503, { error: '服务尚未配置 API 密钥，请联系网站管理员' });
  }

  let body;
  try {
    body = request.body;
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    return sendJson(response, 400, { error: '请求内容格式不正确' });
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(response, 400, { error: '请输入问题后再发送' });
  }

  const messages = body.messages
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .slice(-12)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }));

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return sendJson(response, 400, { error: '问题内容无效' });
  }

  if (!isCampusQuestion(messages[messages.length - 1].content)) {
    return sendJson(response, 200, { answer: OFF_TOPIC_REPLY });
  }

  const knowledgeAnswer = findKnowledgeAnswer(messages[messages.length - 1].content);
  if (knowledgeAnswer) {
    return sendJson(response, 200, { answer: knowledgeAnswer });
  }

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        thinking: { type: 'disabled' },
        stream: false,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok) {
      const status = upstream.status;
      console.error('DeepSeek API returned HTTP', status);
      const message = status === 401 || status === 403
        ? 'API 密钥无效或无权限，请管理员检查 Vercel 环境变量'
        : status === 429
          ? 'API 当前请求较多或额度不足，请稍后重试'
          : 'AI 服务暂时不可用，请稍后重试';
      return sendJson(response, 502, { error: message });
    }

    const data = await upstream.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      return sendJson(response, 502, { error: 'AI 暂未生成回答，请稍后重试' });
    }
    return sendJson(response, 200, { answer: answer.trim() });
  } catch (error) {
    console.error('DeepSeek request failed:', error?.name || 'unknown error');
    const timeout = error?.name === 'TimeoutError';
    return sendJson(response, 502, { error: timeout ? '等待时间较长，请稍后重试' : '无法连接 AI 服务，请稍后重试' });
  }
}


