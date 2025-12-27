from fastapi import FastAPI
import core

app = FastAPI()

@app.get("/")
def root():
    return {"message": "PRM API"}

@app.get("/test/normalize-phone/{phone}")
def normalize_phone(phone: str):
    return {"original": phone, "normalized": core.normalize_phone(phone)}
