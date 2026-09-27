"""
Offline, rule-based resume / JD parser.

Used automatically when the Groq API key is missing, the network is down, or
the LLM returns something unusable. It produces the exact same JSON shape as
groq_parser.parse_resume / parse_job_description, so the rest of the pipeline
never has to care which parser ran.
"""
import re
from datetime import date
from typing import Dict, List, Optional, Tuple

# ── Vocabulary ─────────────────────────────────────────────────────────────
SKILL_VOCAB = [
    # languages
    'python', 'java', 'javascript', 'typescript', 'c', 'c++', 'c#', 'go', 'golang', 'rust', 'ruby',
    'php', 'swift', 'kotlin', 'scala', 'r', 'matlab', 'sql', 'bash', 'shell', 'perl', 'dart', 'html',
    'css', 'sass', 'solidity',
    # web / frameworks
    'react', 'react.js', 'reactjs', 'next.js', 'nextjs', 'vue', 'vue.js', 'angular', 'svelte', 'node.js',
    'nodejs', 'express', 'express.js', 'django', 'flask', 'fastapi', 'spring', 'spring boot', 'rails',
    'laravel', '.net', 'asp.net', 'tailwind', 'tailwindcss', 'bootstrap', 'redux', 'graphql',
    'rest api', 'grpc', 'websockets', 'jquery', 'streamlit', 'gradio', 'flutter',
    'react native',
    # data / ml / ai
    'machine learning', 'deep learning', 'nlp', 'natural language processing', 'computer vision',
    'pytorch', 'tensorflow', 'keras', 'scikit-learn', 'sklearn', 'pandas', 'numpy', 'scipy',
    'matplotlib', 'seaborn', 'plotly', 'opencv', 'hugging face', 'huggingface', 'transformers',
    'bert', 'gpt', 'llm', 'langchain', 'langgraph', 'llamaindex', 'rag', 'openai', 'groq',
    'prompt engineering', 'fine-tuning', 'sentence transformers', 'spacy', 'nltk', 'xgboost',
    'lightgbm', 'data analysis', 'data science', 'data visualization', 'statistics', 'mlops',
    'mlflow', 'airflow', 'spark', 'pyspark', 'hadoop', 'kafka', 'dbt', 'tableau', 'power bi',
    'excel', 'etl', 'feature engineering', 'a/b testing', 'vector database', 'faiss', 'pinecone',
    'chromadb', 'weaviate', 'embeddings', 'generative ai', 'agents', 'ai agents',
    # databases
    'postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'elasticsearch', 'dynamodb',
    'cassandra', 'firebase', 'supabase', 'oracle', 'snowflake', 'bigquery', 'neo4j',
    # cloud / devops
    'aws', 'azure', 'gcp', 'google cloud', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible',
    'jenkins', 'github actions', 'ci/cd', 'linux', 'nginx', 'serverless', 'lambda', 'ec2', 's3',
    'heroku', 'vercel', 'netlify', 'render', 'git', 'github', 'gitlab', 'bitbucket', 'jira',
    'microservices', 'system design', 'distributed systems', 'unit testing', 'pytest', 'jest',
    'selenium', 'playwright', 'cypress', 'postman', 'figma', 'agile', 'scrum', 'oop',
    'data structures', 'algorithms',
    # soft skills
    'leadership', 'communication', 'teamwork', 'problem solving', 'problem-solving',
    'project management', 'stakeholder management', 'mentoring', 'collaboration',
    'time management', 'critical thinking',
]

ACTION_VERBS = {
    'achieved', 'analyzed', 'architected', 'automated', 'built', 'collaborated', 'conducted',
    'configured', 'created', 'decreased', 'delivered', 'deployed', 'designed', 'developed',
    'drove', 'engineered', 'enhanced', 'established', 'executed', 'expanded', 'generated',
    'grew', 'guided', 'handled', 'implemented', 'improved', 'increased', 'initiated',
    'integrated', 'introduced', 'launched', 'led', 'managed', 'mentored', 'migrated',
    'modernized', 'optimized', 'orchestrated', 'organized', 'owned', 'pioneered', 'planned',
    'produced', 'programmed', 'reduced', 'refactored', 'resolved', 'restructured', 'revamped',
    'scaled', 'shipped', 'simplified', 'spearheaded', 'streamlined', 'strengthened',
    'supervised', 'trained', 'transformed', 'tuned', 'upgraded', 'wrote', 'researched',
    'evaluated', 'coordinated', 'facilitated', 'maintained', 'fine-tuned', 'containerized',
    'visualized', 'accelerated', 'boosted', 'cut', 'saved', 'won', 'authored', 'published',
    'develop', 'build', 'design', 'implement', 'lead', 'manage', 'create', 'optimize',
}

SECTION_ALIASES = {
    'summary':        ['summary', 'professional summary', 'profile', 'about me', 'about',
                       'objective', 'career objective', 'professional profile', 'overview'],
    'skills':         ['skills', 'technical skills', 'core skills', 'key skills', 'tech stack',
                       'technologies', 'core competencies', 'competencies', 'tools',
                       'skills & tools', 'skills and tools', 'tools & technologies'],
    'experience':     ['experience', 'work experience', 'professional experience', 'employment',
                       'employment history', 'work history', 'internships', 'internship',
                       'relevant experience', 'career history'],
    'education':      ['education', 'academic background', 'academics', 'qualifications',
                       'educational qualifications', 'academic qualifications'],
    'projects':       ['projects', 'personal projects', 'academic projects', 'key projects',
                       'selected projects', 'project experience', 'side projects'],
    'certifications': ['certifications', 'certificates', 'licenses', 'courses',
                       'certifications & courses', 'achievements', 'awards'],
}

MONTHS = {m: i for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 1)}

EMAIL_RE    = re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+')
PHONE_RE    = re.compile(r'(\+?\d[\d\s().-]{8,}\d)')
LINKEDIN_RE = re.compile(r'(?:https?://)?(?:www\.)?linkedin\.com/[^\s|,]+', re.I)
GITHUB_RE   = re.compile(r'(?:https?://)?(?:www\.)?github\.com/[^\s|,]+', re.I)
BULLET_RE   = re.compile(r'^\s*[•\-\*◦▪●►‣–]\s*')
DATE_TOKEN  = r'(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*,?\s*)?(?:19|20)\d{2}'
RANGE_RE    = re.compile(
    rf'({DATE_TOKEN}|\d{{1,2}}/(?:19|20)\d{{2}})\s*(?:-|–|—|to)\s*'
    rf'({DATE_TOKEN}|\d{{1,2}}/(?:19|20)\d{{2}}|present|current|now|till date|ongoing)',
    re.I,
)


# ── helpers ───────────────────────────────────────────────────────────────
def _norm_heading(line: str) -> str:
    return re.sub(r'[^a-z& ]', '', line.lower()).strip()


def _detect_section(line: str) -> Optional[str]:
    stripped = line.strip().rstrip(':').strip()
    if not stripped or len(stripped) > 40:
        return None
    norm = _norm_heading(stripped)
    for section, aliases in SECTION_ALIASES.items():
        if norm in aliases:
            return section
    return None


def split_sections(text: str) -> Tuple[List[str], Dict[str, List[str]]]:
    header_lines: List[str] = []
    sections: Dict[str, List[str]] = {}
    current = None
    for raw in text.split('\n'):
        line = raw.rstrip()
        sec = _detect_section(line)
        if sec:
            current = sec
            sections.setdefault(sec, [])
            continue
        # "Skills: Python, SQL" style one-liners
        m = re.match(r'^\s*([A-Za-z &]{3,30}):\s*(.+)$', line)
        if m and _detect_section(m.group(1)) == 'skills':
            sections.setdefault('skills', []).append(m.group(2))
            continue
        if current is None:
            header_lines.append(line)
        else:
            sections[current].append(line)
    return header_lines, sections


def _find_vocab(text: str) -> List[str]:
    low = ' ' + text.lower() + ' '
    found = []
    for term in SKILL_VOCAB:
        pattern = r'(?<![\w+#.])' + re.escape(term) + r'(?![\w+#])'
        if re.search(pattern, low):
            found.append(term)
    # drop single-letter languages unless clearly listed (avoids false "c"/"r")
    return [f for f in found if len(f) > 1 or re.search(rf'(?:^|[,|•:]\s*){re.escape(f)}\s*(?:[,|•]|$)', text, re.I | re.M)]


def _pretty(term: str) -> str:
    special = {
        'aws': 'AWS', 'gcp': 'GCP', 'sql': 'SQL', 'nlp': 'NLP', 'llm': 'LLM', 'llms': 'LLMs',
        'rag': 'RAG', 'html': 'HTML', 'css': 'CSS', 'etl': 'ETL', 'ci/cd': 'CI/CD', 'oop': 'OOP',
        'mlops': 'MLOps', 'fastapi': 'FastAPI', 'postgresql': 'PostgreSQL', 'mongodb': 'MongoDB',
        'mysql': 'MySQL', 'javascript': 'JavaScript', 'typescript': 'TypeScript', 'github': 'GitHub',
        'gitlab': 'GitLab', 'pytorch': 'PyTorch', 'tensorflow': 'TensorFlow', 'scikit-learn': 'scikit-learn',
        'numpy': 'NumPy', 'openai': 'OpenAI', 'graphql': 'GraphQL', 'langchain': 'LangChain',
        'langgraph': 'LangGraph', 'llamaindex': 'LlamaIndex', 'opencv': 'OpenCV', 'bert': 'BERT',
        'gpt': 'GPT', 'xgboost': 'XGBoost', 'lightgbm': 'LightGBM', 'power bi': 'Power BI',
        'c++': 'C++', 'c#': 'C#', '.net': '.NET', 'asp.net': 'ASP.NET', 'node.js': 'Node.js',
        'next.js': 'Next.js', 'vue.js': 'Vue.js', 'react.js': 'React.js', 'express.js': 'Express.js',
        'bigquery': 'BigQuery', 'dynamodb': 'DynamoDB', 'chromadb': 'ChromaDB', 'faiss': 'FAISS',
        'ec2': 'EC2', 's3': 'S3', 'rest api': 'REST API', 'rest apis': 'REST APIs', 'rest': 'REST',
        'grpc': 'gRPC', 'k8s': 'K8s', 'jira': 'Jira', 'a/b testing': 'A/B Testing', 'php': 'PHP',
        'hugging face': 'Hugging Face', 'huggingface': 'HuggingFace', 'spacy': 'spaCy', 'nltk': 'NLTK',
    }
    return special.get(term, term.title() if ' ' in term else term.capitalize())


def _parse_date(tok: str, is_end: bool = False) -> Optional[date]:
    tok = tok.strip().lower()
    if tok in ('present', 'current', 'now', 'till date', 'ongoing'):
        return date.today()
    m = re.match(r'(\d{1,2})/((?:19|20)\d{2})', tok)
    if m:
        return date(int(m.group(2)), max(1, min(12, int(m.group(1)))), 1)
    year = re.search(r'(19|20)\d{2}', tok)
    if not year:
        return None
    month = 12 if is_end else 1
    for k, v in MONTHS.items():
        if tok.startswith(k):
            month = v
            break
    return date(int(year.group()), month, 1)


def _months_between(start: str, end: str) -> int:
    s, e = _parse_date(start), _parse_date(end, is_end=True)
    if not s or not e or e < s:
        return 0
    return (e.year - s.year) * 12 + (e.month - s.month) + 1


def _strip_bullet(line: str) -> str:
    return BULLET_RE.sub('', line).strip()


def _entries(lines: List[str]) -> List[List[str]]:
    """Group section lines into entries: a non-bullet line after bullets starts a new entry."""
    entries: List[List[str]] = []
    cur: List[str] = []
    saw_bullet = False
    for line in lines:
        if not line.strip():
            continue
        is_bullet = bool(BULLET_RE.match(line))
        if not is_bullet and (saw_bullet or (cur and RANGE_RE.search(line) and RANGE_RE.search(' '.join(cur)))):
            entries.append(cur)
            cur, saw_bullet = [], False
        cur.append(line)
        saw_bullet = saw_bullet or is_bullet
    if cur:
        entries.append(cur)
    return entries


# ── public API ────────────────────────────────────────────────────────────
def parse_resume_locally(raw_text: str) -> Dict:
    text = raw_text.replace('\r', '')
    header, sections = split_sections(text)

    email = EMAIL_RE.search(text)
    phone = PHONE_RE.search(text)
    linkedin = LINKEDIN_RE.search(text)
    github = GITHUB_RE.search(text)

    name = ''
    for line in (header or text.split('\n'))[:6]:
        clean = line.strip()
        if clean and not EMAIL_RE.search(clean) and not re.search(r'\d', clean) and len(clean.split()) <= 5:
            name = clean
            break

    summary = ' '.join(l.strip() for l in sections.get('summary', []) if l.strip())

    # skills: explicit section + vocabulary scan of whole text
    skills: List[str] = []
    seen = set()
    for line in sections.get('skills', []):
        line = _strip_bullet(line)
        if ':' in line:
            line = line.split(':', 1)[1]
        for part in re.split(r'[,|•;/]|\s{2,}', line):
            part = part.strip(' .-–')
            if 1 < len(part) <= 35 and part.lower() not in seen:
                seen.add(part.lower())
                skills.append(part)
    for term in _find_vocab(text):
        if term not in seen and not any(term in s.lower() for s in skills):
            seen.add(term)
            skills.append(_pretty(term))

    # experience
    experience = []
    for entry in _entries(sections.get('experience', [])):
        head = [l for l in entry if not BULLET_RE.match(l)]
        bullets = [_strip_bullet(l) for l in entry if BULLET_RE.match(l)]
        head_text = ' | '.join(h.strip() for h in head)
        rng = RANGE_RE.search(head_text)
        start, end = (rng.group(1), rng.group(2)) if rng else ('', '')
        title_line = RANGE_RE.sub('', head[0] if head else '').strip(' |,-–—')
        parts = [p.strip() for p in re.split(r'\s[|@–—-]\s|,\s| at ', title_line) if p.strip()]
        experience.append({
            'job_title': parts[0] if parts else title_line,
            'company': parts[1] if len(parts) > 1 else (RANGE_RE.sub('', head[1]).strip(' |,-') if len(head) > 1 else ''),
            'start_date': start.strip(),
            'end_date': end.strip(),
            'duration_months': _months_between(start, end) if rng else 0,
            'description': '\n'.join(bullets) if bullets else ' '.join(head[1:]),
        })

    # education
    education = []
    for entry in _entries(sections.get('education', [])):
        joined = ' '.join(l.strip() for l in entry)
        year = re.findall(r'(?:19|20)\d{2}', joined)
        lines = [_strip_bullet(l) for l in entry if l.strip()]
        education.append({
            'degree': lines[0] if lines else joined[:80],
            'institution': lines[1] if len(lines) > 1 else '',
            'year': year[-1] if year else '',
        })

    # projects
    projects = []
    for entry in _entries(sections.get('projects', [])):
        head = [l for l in entry if not BULLET_RE.match(l)]
        bullets = [_strip_bullet(l) for l in entry if BULLET_RE.match(l)]
        title = (head[0] if head else _strip_bullet(entry[0])).strip()
        title_clean = re.split(r'\s[|–—-]\s|:', title)[0].strip()
        desc = ' '.join(bullets) or ' '.join(head[1:]) or title
        projects.append({
            'title': title_clean[:80],
            'description': (title + ' ' + desc).strip() if title_clean != title else desc,
            'technologies': [_pretty(t) for t in _find_vocab(title + ' ' + desc)],
        })

    certifications = [_strip_bullet(l) for l in sections.get('certifications', []) if l.strip()]

    # action verbs: first word of bullet / sentence lines
    verbs = []
    for line in text.split('\n'):
        first = re.match(r'[A-Za-z-]+', _strip_bullet(line))
        if first:
            w = first.group().lower()
            if w in ACTION_VERBS and w not in verbs:
                verbs.append(w)

    keywords = list(dict.fromkeys([_pretty(t) for t in _find_vocab(text)] + [s for s in skills[:25]]))

    return {
        'name': name,
        'email': email.group() if email else None,
        'phone': phone.group().strip() if phone else None,
        'linkedin': linkedin.group() if linkedin else None,
        'github': github.group() if github else None,
        'professional_summary': summary,
        'skills': skills[:60],
        'experience': experience,
        'education': education,
        'certifications': certifications[:20],
        'projects': projects,
        'action_verbs': [v.capitalize() for v in verbs],
        'keywords': keywords[:60],
        '_parser': 'local',
    }


def parse_jd_locally(raw_text: str) -> Dict:
    text = raw_text.replace('\r', '')
    low = text.lower()
    found = [_pretty(t) for t in _find_vocab(text)]

    preferred_zone = ''
    m = re.search(r'(nice to have|preferred|bonus|good to have|plus)[\s\S]*', low)
    if m:
        preferred_zone = m.group()
    preferred = [s for s in found if s.lower() in preferred_zone]
    required = [s for s in found if s not in preferred]

    title = ''
    m_title = re.search(r'(?:job title|position|role)\s*[:\-]\s*(.+)', text, re.I)
    if m_title:
        title = m_title.group(1)
    else:
        for line in text.split('\n'):
            if line.strip():
                title = line.strip()
                break
    title = re.split(r'[.!?|(]|\s[-–—]\s|:\s|\bRequired\b', title)[0].strip()[:60]

    exp = re.search(r'(\d+\+?\s*(?:-\s*\d+\s*)?years?)', low)
    return {
        'job_title': title,
        'required_skills': required,
        'preferred_skills': preferred,
        'experience_required': exp.group(1) if exp else '',
        'education_required': '',
        'key_responsibilities': [_strip_bullet(l) for l in text.split('\n') if BULLET_RE.match(l)][:10],
        'keywords': found,
        '_parser': 'local',
    }
