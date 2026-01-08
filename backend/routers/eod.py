from fastapi import APIRouter, Query

router = APIRouter()


@router.post("/contacts/{person_id}/context")
def add_contact_context(person_id: int, notes: str = Query(...)):
    """Add context/notes to a contact - dummy implementation"""
    return {
        "success": True,
        "person_id": person_id,
        "notes": notes,
    }
