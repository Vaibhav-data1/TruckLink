import base64
import hashlib
import hmac
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import Float, ForeignKey, Integer, String, Text, create_engine, select, update
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./trucklink.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
TOKEN_SECRET = os.getenv("JWT_SECRET", "local-development-secret-change-me")
DEMO_OTP = os.getenv("DEMO_OTP", "true").lower() == "true"
DOCUMENT_DIR = Path(os.getenv("DOCUMENT_DIR", "./uploads")).resolve()
RATE_PER_KM = float(os.getenv("RATE_PER_KM", "20"))
MINIMUM_FARE = float(os.getenv("MINIMUM_FARE", "500"))
VEHICLE_MULTIPLIERS = {"mini": 1.0, "pickup": 1.15, "truck": 1.35, "heavy": 1.7}
OTP_TTL_MINUTES = 10
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    phone: Mapped[str] = mapped_column(String(20))
    role: Mapped[str] = mapped_column(String(12))
    password_hash: Mapped[str] = mapped_column(String(256))


class Truck(Base):
    __tablename__ = "trucks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    vehicle_type: Mapped[str] = mapped_column(String(20), default="truck")
    registration: Mapped[str] = mapped_column(String(20))
    capacity_kg: Mapped[float] = mapped_column(Float)


class FreightRequest(Base):
    __tablename__ = "freight_requests"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    pickup: Mapped[str] = mapped_column(String(200))
    destination: Mapped[str] = mapped_column(String(200))
    goods_type: Mapped[str] = mapped_column(String(100))
    weight_kg: Mapped[float] = mapped_column(Float)
    description: Mapped[str] = mapped_column(Text, default="")
    distance_km: Mapped[float] = mapped_column(Float)
    fare: Mapped[float] = mapped_column(Float)
    vehicle_type: Mapped[str] = mapped_column(String(20), default="truck")
    status: Mapped[str] = mapped_column(String(24), default="open", index=True)
    otp_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    otp_kind: Mapped[str | None] = mapped_column(String(12), nullable=True)
    otp_expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("freight_requests.id"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    amount: Mapped[float] = mapped_column(Float)
    kind: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(20), default="simulated")
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class Location(Base):
    __tablename__ = "locations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("freight_requests.id"), index=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    recorded_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("freight_requests.id"), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(255))
    storage_name: Mapped[str] = mapped_column(String(100), unique=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))


Base.metadata.create_all(engine)

app = FastAPI(title="TruckLink API", version="1.0.0")
allowed_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "*").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=allowed_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

bearer = HTTPBearer(auto_error=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{base64.urlsafe_b64encode(salt).decode()}:{base64.urlsafe_b64encode(hashed).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_text, hash_text = stored.split(":", 1)
        salt = base64.urlsafe_b64decode(salt_text)
        expected = base64.urlsafe_b64decode(hash_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def create_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({"sub": str(user.id), "role": user.role, "exp": int((now + timedelta(hours=12)).timestamp())}).encode())
    unsigned = f"{header}.{payload}"
    signature = b64(hmac.new(TOKEN_SECRET.encode(), unsigned.encode(), hashlib.sha256).digest())
    return f"{unsigned}.{signature}"


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    try:
        header, payload, signature = credentials.credentials.split(".")
        unsigned = f"{header}.{payload}"
        expected = b64(hmac.new(TOKEN_SECRET.encode(), unsigned.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("Signature mismatch")
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if data["exp"] < datetime.now(timezone.utc).timestamp():
            raise ValueError("Token expired")
        user = db.get(User, int(data["sub"]))
        if not user:
            raise ValueError("Unknown user")
        return user
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=401, detail="Your session expired. Please sign in again")


def require_role(role: str):
    def role_guard(user: User = Depends(current_user)) -> User:
        if user.role != role:
            raise HTTPException(status_code=403, detail=f"This action is for {role}s")
        return user

    return role_guard


class RegisterInput(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    phone: str = Field(min_length=8, max_length=20)
    password: str = Field(min_length=8, max_length=128)
    role: Literal["customer", "driver"]
    vehicle_type: Literal["mini", "pickup", "truck", "heavy"] = "truck"
    registration: str = Field(default="", max_length=20)
    capacity_kg: float = Field(default=5000, gt=0, le=100000)


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class ProfileInput(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    phone: str = Field(min_length=8, max_length=20)


class BookingInput(BaseModel):
    pickup: str = Field(min_length=2, max_length=200)
    destination: str = Field(min_length=2, max_length=200)
    goods_type: str = Field(min_length=2, max_length=100)
    weight_kg: float = Field(gt=0, le=100000)
    description: str = Field(default="", max_length=2000)
    distance_km: float = Field(gt=0, le=5000)
    vehicle_type: Literal["mini", "pickup", "truck", "heavy"] = "truck"


class OtpInput(BaseModel):
    kind: Literal["start", "delivery"]


class VerifyOtpInput(BaseModel):
    kind: Literal["start", "delivery"]
    code: str = Field(min_length=6, max_length=6)


class LocationInput(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


def user_view(user: User) -> dict:
    return {"id": user.id, "name": user.name, "email": user.email, "phone": user.phone, "role": user.role}


def booking_view(booking: FreightRequest, db: Session) -> dict:
    driver = db.get(User, booking.driver_id) if booking.driver_id else None
    payment_rows = list(db.scalars(select(Payment).where(Payment.booking_id == booking.id)))
    paid = sum(payment.amount for payment in payment_rows if payment.kind != "settlement")
    return {
        "id": booking.id,
        "customer_id": booking.customer_id,
        "driver_id": booking.driver_id,
        "driver_name": driver.name if driver else None,
        "pickup": booking.pickup,
        "destination": booking.destination,
        "goods_type": booking.goods_type,
        "weight_kg": booking.weight_kg,
        "description": booking.description,
        "distance_km": booking.distance_km,
        "fare": booking.fare,
        "vehicle_type": booking.vehicle_type,
        "status": booking.status,
        "paid": paid,
        "balance": max(booking.fare - paid, 0),
        "created_at": booking.created_at.isoformat(),
    }


def get_booking(booking_id: int, db: Session) -> FreightRequest:
    booking = db.get(FreightRequest, booking_id)
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")
    return booking


def can_view_booking(booking: FreightRequest, user: User):
    if user.role == "customer" and booking.customer_id != user.id:
        raise HTTPException(status_code=404, detail="Booking not found")
    if user.role == "driver" and booking.driver_id != user.id and booking.status != "open":
        raise HTTPException(status_code=404, detail="Booking not found")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/auth/register", status_code=201)
def register(payload: RegisterInput, db: Session = Depends(get_db)):
    email = payload.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    user = User(name=payload.name.strip(), email=email, phone=payload.phone.strip(), role=payload.role, password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    if user.role == "driver":
        db.add(Truck(driver_id=user.id, vehicle_type=payload.vehicle_type, registration=payload.registration.strip() or "DEMO", capacity_kg=payload.capacity_kg))
    db.commit()
    db.refresh(user)
    return {"token": create_token(user), "user": user_view(user)}


@app.post("/api/auth/login")
def login(payload: LoginInput, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    return {"token": create_token(user), "user": user_view(user)}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    result = user_view(user)
    if user.role == "driver":
        truck = db.scalar(select(Truck).where(Truck.driver_id == user.id))
        if truck:
            result["truck"] = {"vehicle_type": truck.vehicle_type, "registration": truck.registration, "capacity_kg": truck.capacity_kg}
    return result


@app.patch("/api/auth/me")
def update_profile(payload: ProfileInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.name = payload.name.strip()
    user.phone = payload.phone.strip()
    db.commit()
    db.refresh(user)
    return user_view(user)


@app.post("/api/bookings", status_code=201)
def create_booking(payload: BookingInput, user: User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    fare = max(MINIMUM_FARE, round(payload.distance_km * RATE_PER_KM * VEHICLE_MULTIPLIERS[payload.vehicle_type]))
    booking = FreightRequest(
        customer_id=user.id,
        pickup=payload.pickup.strip(),
        destination=payload.destination.strip(),
        goods_type=payload.goods_type.strip(),
        weight_kg=payload.weight_kg,
        description=payload.description.strip(),
        distance_km=payload.distance_km,
        fare=fare,
        vehicle_type=payload.vehicle_type,
    )
    db.add(booking)
    db.commit()
    db.refresh(booking)
    return booking_view(booking, db)


@app.get("/api/bookings")
def list_bookings(user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = select(FreightRequest)
    if user.role == "customer":
        query = query.where(FreightRequest.customer_id == user.id)
    else:
        query = query.where((FreightRequest.status == "open") | (FreightRequest.driver_id == user.id))
    return [booking_view(row, db) for row in db.scalars(query.order_by(FreightRequest.created_at.desc()))]


@app.get("/api/bookings/{booking_id}")
def booking_detail(booking_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    can_view_booking(booking, user)
    result = booking_view(booking, db)
    result["payments"] = [
        {"amount": item.amount, "kind": item.kind, "status": item.status, "created_at": item.created_at.isoformat()}
        for item in db.scalars(select(Payment).where(Payment.booking_id == booking.id).order_by(Payment.created_at))
    ]
    return result


@app.post("/api/bookings/{booking_id}/accept")
def accept_booking(booking_id: int, user: User = Depends(require_role("driver")), db: Session = Depends(get_db)):
    result = db.execute(
        update(FreightRequest)
        .where(FreightRequest.id == booking_id, FreightRequest.status == "open", FreightRequest.driver_id.is_(None))
        .values(status="accepted", driver_id=user.id)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="This job is no longer available")
    db.commit()
    return booking_view(get_booking(booking_id, db), db)


@app.post("/api/bookings/{booking_id}/otp")
def issue_otp(booking_id: int, payload: OtpInput, user: User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    if booking.customer_id != user.id:
        raise HTTPException(status_code=404, detail="Booking not found")
    valid_status = booking.status in ({"accepted"} if payload.kind == "start" else {"in_transit"})
    if not valid_status:
        raise HTTPException(status_code=409, detail="This trip is not ready for verification")
    code = f"{secrets.randbelow(1_000_000):06d}"
    booking.otp_hash = hashlib.sha256(code.encode()).hexdigest()
    booking.otp_kind = payload.kind
    booking.otp_expires_at = datetime.now(timezone.utc) + timedelta(minutes=OTP_TTL_MINUTES)
    if payload.kind == "start":
        booking.status = "awaiting_loading"
    else:
        booking.status = "delivered"
    db.commit()
    response = {"message": "Demo verification code created. Share it with your driver.", "expires_in_minutes": OTP_TTL_MINUTES}
    if DEMO_OTP:
        response["demo_code"] = code
        response["demo_label"] = "Development only — no SMS was sent"
    return response


@app.post("/api/bookings/{booking_id}/verify-otp")
def verify_otp(booking_id: int, payload: VerifyOtpInput, user: User = Depends(require_role("driver")), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    if booking.driver_id != user.id:
        raise HTTPException(status_code=404, detail="Booking not found")
    expected_status = "awaiting_loading" if payload.kind == "start" else "delivered"
    if booking.status != expected_status or booking.otp_kind != payload.kind or not booking.otp_hash or not booking.otp_expires_at:
        raise HTTPException(status_code=409, detail="No active verification code for this trip")
    expires = booking.otp_expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Verification code expired. Ask the customer for a new one.")
    if not hmac.compare_digest(booking.otp_hash, hashlib.sha256(payload.code.encode()).hexdigest()):
        raise HTTPException(status_code=400, detail="Verification code is incorrect")
    booking.otp_hash = None
    booking.otp_kind = None
    booking.otp_expires_at = None
    booking.status = "loading_verified" if payload.kind == "start" else "completed"
    if payload.kind == "delivery":
        booking.driver_id = user.id
    db.commit()
    return booking_view(booking, db)


@app.patch("/api/bookings/{booking_id}/status")
def update_status(
    booking_id: int,
    status: Literal["in_transit", "cancelled"],
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    booking = get_booking(booking_id, db)
    if status == "cancelled":
        if user.role != "customer" or booking.customer_id != user.id or booking.status not in {"open", "accepted"}:
            raise HTTPException(status_code=403, detail="This booking cannot be cancelled")
    elif user.role != "driver" or booking.driver_id != user.id or booking.status != "loading_verified":
        raise HTTPException(status_code=409, detail="Verify loading before starting this trip")
    booking.status = status
    db.commit()
    return booking_view(booking, db)


@app.post("/api/bookings/{booking_id}/payment")
def simulate_payment(booking_id: int, kind: Literal["deposit", "settlement"], user: User = Depends(require_role("customer")), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    if booking.customer_id != user.id:
        raise HTTPException(status_code=404, detail="Booking not found")
    rows = list(db.scalars(select(Payment).where(Payment.booking_id == booking.id)))
    if kind == "deposit":
        if booking.status not in {"accepted", "awaiting_loading", "loading_verified", "in_transit", "delivered"}:
            raise HTTPException(status_code=409, detail="A deposit is available after a driver accepts")
        if any(row.kind == "deposit" for row in rows):
            raise HTTPException(status_code=409, detail="Deposit has already been recorded")
        amount = round(booking.fare * 0.2, 2)
    else:
        if booking.status != "completed":
            raise HTTPException(status_code=409, detail="Settlement is available after delivery verification")
        if any(row.kind == "settlement" for row in rows):
            raise HTTPException(status_code=409, detail="Settlement has already been recorded")
        amount = round(max(booking.fare - sum(row.amount for row in rows), 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=409, detail="No balance remains")
    payment = Payment(booking_id=booking.id, customer_id=user.id, driver_id=booking.driver_id, amount=amount, kind=kind)
    db.add(payment)
    db.commit()
    return {"amount": amount, "kind": kind, "status": "simulated", "message": "Demo payment recorded; no money was transferred"}


@app.post("/api/bookings/{booking_id}/location")
def add_location(booking_id: int, payload: LocationInput, user: User = Depends(require_role("driver")), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    if booking.driver_id != user.id or booking.status != "in_transit":
        raise HTTPException(status_code=409, detail="Location sharing is only available during your active trip")
    location = Location(booking_id=booking.id, driver_id=user.id, latitude=payload.latitude, longitude=payload.longitude)
    db.add(location)
    db.commit()
    return {"recorded_at": location.recorded_at.isoformat(), "status": "sharing"}


@app.get("/api/bookings/{booking_id}/location")
def latest_location(booking_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    can_view_booking(booking, user)
    if booking.status not in {"in_transit", "delivered", "completed"}:
        raise HTTPException(status_code=409, detail="Location is not available before the trip starts")
    location = db.scalar(select(Location).where(Location.booking_id == booking.id).order_by(Location.recorded_at.desc()))
    if not location:
        return {"location": None, "stale": True}
    now = datetime.now(timezone.utc)
    recorded = location.recorded_at
    if recorded.tzinfo is None:
        recorded = recorded.replace(tzinfo=timezone.utc)
    age = (now - recorded).total_seconds()
    return {
        "location": {"latitude": location.latitude, "longitude": location.longitude},
        "recorded_at": recorded.isoformat(),
        "stale": age > 300,
    }


@app.post("/api/bookings/{booking_id}/documents", status_code=201)
async def upload_document(
    booking_id: int,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    booking = get_booking(booking_id, db)
    can_view_booking(booking, user)
    if user.role == "driver" and booking.driver_id != user.id:
        raise HTTPException(status_code=404, detail="Booking not found")
    if not file.filename or not file.filename.lower().endswith(".pdf") or file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Upload a PDF document")
    content = await file.read(MAX_DOCUMENT_BYTES + 1)
    if len(content) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="PDF must be 10 MB or smaller")
    if not content.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="The uploaded file is not a valid PDF")
    storage_name = f"{uuid.uuid4()}.pdf"
    DOCUMENT_DIR.mkdir(parents=True, exist_ok=True)
    (DOCUMENT_DIR / storage_name).write_bytes(content)
    document = Document(
        id=str(uuid.uuid4()),
        booking_id=booking.id,
        owner_id=user.id,
        filename=Path(file.filename).name[:255],
        storage_name=storage_name,
        size_bytes=len(content),
    )
    db.add(document)
    db.commit()
    return {"id": document.id, "filename": document.filename, "size_bytes": document.size_bytes}


@app.get("/api/bookings/{booking_id}/documents")
def list_documents(booking_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    booking = get_booking(booking_id, db)
    can_view_booking(booking, user)
    return [
        {"id": item.id, "filename": item.filename, "size_bytes": item.size_bytes, "download_url": f"/api/documents/{item.id}"}
        for item in db.scalars(select(Document).where(Document.booking_id == booking.id))
    ]


@app.get("/api/documents/{document_id}")
def download_document(document_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    from fastapi.responses import FileResponse

    document = db.get(Document, document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    booking = get_booking(document.booking_id, db)
    can_view_booking(booking, user)
    path = DOCUMENT_DIR / document.storage_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Document file is not available")
    return FileResponse(path, media_type="application/pdf", filename=document.filename)
