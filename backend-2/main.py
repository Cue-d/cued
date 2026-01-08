from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import chats, actions, search, eod, sync

app = FastAPI(title="PRM Backend 2 (Minimal)")

# CORS for browser dev mode
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(chats.router, prefix="/chats", tags=["chats"])
app.include_router(actions.router, prefix="/actions", tags=["actions"])
app.include_router(search.router, prefix="/search", tags=["search"])
app.include_router(eod.router, prefix="/eod", tags=["eod"])
app.include_router(sync.router, prefix="/sync", tags=["sync"])


@app.get("/health")
def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
