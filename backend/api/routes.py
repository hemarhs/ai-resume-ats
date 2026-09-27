import logging
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from backend.api.auth import get_current_user
from backend.core.config import GOOGLE_CLIENT_ID, GROQ_API_KEY, GROQ_MODEL
from backend.database import history_repo
from backend.models.schemas import AnalysisResponse, ComponentScores, JDComparison, SkillValidationDetails

logger = logging.getLogger('ats_resume_scorer')

router = APIRouter(prefix='/api/v1', tags=['Analysis'])


def _build_response(result: dict, filename: str) -> AnalysisResponse:
    jd = result.get('jd_comparison')
    jd_model = None
    if jd:
        jd_model = JDComparison(
            match_percentage=round(float(jd.get('match_percentage', 0.0)), 1),
            semantic_similarity=round(float(jd.get('semantic_similarity', 0.0)), 3),
            matched_keywords=jd.get('matched_keywords', [])[:25],
            missing_keywords=jd.get('missing_keywords', [])[:15],
            skills_gap=jd.get('skills_gap', [])[:12],
            job_title=jd.get('job_title', '') or '',
        )

    svd = result.get('skill_validation_details') or {}
    return AnalysisResponse(
        ATS_score=result['ats_score'],
        component_scores=ComponentScores(**result['component_scores']),
        issues_summary=result['issues_summary'],
        detailed_feedback=result.get('detailed_feedback', []),
        jd_match_analysis=jd_model,
        skill_validation_details=SkillValidationDetails(
            validated=svd.get('validated', []),
            unvalidated=svd.get('unvalidated', []),
            total=svd.get('total', 0),
            validated_count=svd.get('validated_count', 0),
            validation_pct=svd.get('validation_pct', 0.0),
        ),
        ats_score=result['ats_score'],
        keyword_match=jd_model.match_percentage if jd_model else 0.0,
        missing_keywords=result.get('missing_keywords', []),
        matched_keywords=result.get('matched_keywords', []),
        strengths=result.get('strengths', []),
        skills=list(result.get('skills', []))[:40],
        jd_comparison=jd_model,
        interpretation=result.get('interpretation', ''),
        filename=filename,
        created_at=datetime.now(timezone.utc).isoformat(),
        candidate=result.get('candidate', {}),
        stats=result.get('stats', {}),
        experience_months=int(result.get('experience_months', 0) or 0),
        parser=result.get('parser', ''),
    )


@router.get('/config')
async def public_config(request: Request):
    """Public settings the web UI needs at boot."""
    return {
        'google_client_id':  GOOGLE_CLIENT_ID,
        'database':          getattr(request.app.state, 'db_name', ''),
        'llm_enabled':       bool(GROQ_API_KEY),
        'llm_model':         GROQ_MODEL if GROQ_API_KEY else 'local rule-based parser',
        'semantic_model':    getattr(request.app.state, 'embedder_name', ''),
    }


@router.post('/analyze-resume', response_model=AnalysisResponse)
async def analyze_resume(
    request: Request,
    resume: UploadFile = File(..., description='Resume file — PDF or DOCX, max 5 MB'),
    job_description: str = Form('', description='Job description text (optional)'),
    user_id: str = Depends(get_current_user),
):
    nlp      = request.app.state.nlp
    embedder = request.app.state.embedder

    from backend.services.resume_parser import parse_resume_file

    file_bytes = await resume.read()
    filename   = resume.filename or 'resume'
    try:
        resume_text, _meta = await run_in_threadpool(parse_resume_file, file_bytes, filename)
        logger.info(f"Parsed '{filename}': {len(resume_text)} chars extracted")
    except Exception as exc:
        logger.error(f'File parsing failed: {exc}')
        raise HTTPException(status_code=422, detail=str(exc) or 'Could not read the resume file.')

    if len(resume_text.split()) < 30:
        raise HTTPException(
            status_code=422,
            detail='Very little text could be extracted. Is this a scanned image PDF? Please upload a text-based PDF or DOCX.',
        )

    try:
        from backend.services.resume_analyzer import analyze_full_resume
        # CPU-heavy NLP work runs off the event loop so the server stays responsive
        result = await run_in_threadpool(
            analyze_full_resume,
            resume_text=resume_text,
            nlp=nlp,
            embedder=embedder,
            job_description=job_description,
        )
    except Exception as exc:
        logger.exception(f'Full analysis pipeline failed: {exc}')
        raise HTTPException(status_code=500, detail=f'Analysis pipeline failed: {exc}')

    response = _build_response(result, filename)

    try:
        response.id = await run_in_threadpool(history_repo.save_analysis, user_id, filename, response.model_dump())
    except Exception as exc:
        logger.warning(f'History save failed (non-blocking): {exc}')

    return response


@router.get('/health')
async def health_check(request: Request):
    return {
        'status':          'healthy',
        'nlp_loaded':      getattr(request.app.state, 'nlp', None) is not None,
        'embedder_loaded': getattr(request.app.state, 'embedder', None) is not None,
        'embedder':        getattr(request.app.state, 'embedder_name', ''),
        'database':        getattr(request.app.state, 'db_name', ''),
        'llm_enabled':     bool(GROQ_API_KEY),
    }


@router.get('/history')
async def get_history(user_id: str = Depends(get_current_user)):
    try:
        return await run_in_threadpool(history_repo.get_user_history, user_id)
    except Exception as exc:
        logger.error(f'History fetch failed: {exc}')
        raise HTTPException(status_code=500, detail=f'Could not load history: {exc}')


@router.delete('/history/{analysis_id}')
async def delete_history_entry(analysis_id: str, user_id: str = Depends(get_current_user)):
    if not await run_in_threadpool(history_repo.delete_analysis, analysis_id, user_id):
        raise HTTPException(status_code=404, detail='Analysis not found.')
    return {'status': 'deleted', 'id': analysis_id}


def _pdf_response(analysis: dict, name: str) -> Response:
    from backend.services.pdf_export import generate_combined_pdf
    from backend.services.report_generator import generate_html_reports
    try:
        pdf_bytes = generate_combined_pdf(generate_html_reports(analysis))
    except Exception as e:
        logger.error(f'Failed to generate PDF: {e}')
        raise HTTPException(status_code=501, detail=str(e))
    return Response(
        content=pdf_bytes,
        media_type='application/pdf',
        headers={'Content-Disposition': f'attachment; filename={name}'},
    )


@router.post('/generate-pdf')
async def generate_pdf(data: AnalysisResponse, user_id: str = Depends(get_current_user)):
    return _pdf_response(data.model_dump(), 'ats_report.pdf')


@router.get('/history/{analysis_id}/pdf')
async def generate_history_pdf(analysis_id: str, user_id: str = Depends(get_current_user)):
    analysis = await run_in_threadpool(history_repo.get_analysis, analysis_id, user_id)
    if not analysis:
        raise HTTPException(status_code=404, detail='Analysis not found')
    return _pdf_response(analysis, f'ats_report_{analysis_id}.pdf')
