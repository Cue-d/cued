import logging

import core
from fastapi import APIRouter

from schemas import ActionType, EODContactResponse
from sync_db import APP_DB_PATH

logger = logging.getLogger(__name__)
router = APIRouter()


def get_db():
    db = core.AppDb(APP_DB_PATH)
    db.init_schema()
    return db


@router.get("/contacts", response_model=list[EODContactResponse])
def get_eod_contacts():
    """Get today's new contacts that need context."""
    db = get_db()
    contacts = db.get_todays_new_contacts()
    return [
        EODContactResponse(
            person_id=c.id,
            identifier=c.identifier,
            name=c.name,
            is_contact=c.is_contact,
        )
        for c in contacts
    ]


@router.post("/generate")
def generate_eod_actions():
    """Manually trigger EOD contact detection and create actions."""
    db = get_db()
    contacts = db.get_todays_new_contacts()
    created = 0
    for contact in contacts:
        if not db.has_eod_action_today(contact.id):
            db.create_action(
                action_type=ActionType.EOD_CONTACT.value,
                priority=30,
                person_id=contact.id,
                chat_id=None,
                message_id=None,
                payload=None,
                remind_at=None,
            )
            created += 1
    return {"success": True, "actions_created": created}


@router.post("/contacts/{person_id}/context")
def add_contact_context(person_id: int, notes: str):
    """Add context/notes to a person."""
    db = get_db()
    person = db.get_person(person_id)
    if not person:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Person not found")

    # Update the person's notes
    db.upsert_person(
        id=person.id,
        identifier=person.identifier,
        name=person.name,
        service=person.service,
        is_contact=person.is_contact,
        phones=person.phones,
        emails=person.emails,
        company=person.company,
        notes=notes,
    )
    return {"success": True}
