import core
from fastapi import FastAPI

from routers import chats

app = FastAPI()


@app.get("/")
def root():
    return {"message": "PRM API"}


@app.get("/test/normalize-phone/{phone}")
def normalize_phone(phone: str):
    return {"original": phone, "normalized": core.normalize_phone(phone)}


app.include_router(chats.router, prefix="/chats")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
