"""NetEase Cloud Music Mock API Server."""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from mock_data import PLAYLISTS, SONGS, ARTISTS, PLAYER_STATE

app = FastAPI(
    title="NetEase Cloud Music Mock API",
    description="Mock API server mimicking NetEase Cloud Music API structure",
    version="1.0.0",
)

# CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Song(BaseModel):
    id: int
    title: str
    artist_id: int
    artist_name: str
    album_name: str
    album_cover: str
    duration: int
    play_count: int
    comment_count: int
    like_count: int


class Artist(BaseModel):
    id: int
    name: str
    avatar_url: str
    followers: int
    description: str


class PlaylistCreator(BaseModel):
    id: int
    name: str


class Playlist(BaseModel):
    id: int
    name: str
    cover_url: str
    track_count: int
    song_ids: list[int]
    play_count: int
    comment_count: int
    tags: list[str]
    creator: PlaylistCreator
    created_at: str


class PlayerState(BaseModel):
    current_song_id: int
    current_song: dict
    is_playing: bool
    progress: int
    volume: int
    play_mode: str
    playlist: list[int]
    current_index: int
    is_liked: bool


# Endpoints
@app.get("/api/playlists", response_model=list[Playlist])
async def get_playlists():
    return PLAYLISTS


@app.get("/api/playlists/{playlist_id}", response_model=Playlist)
async def get_playlist(playlist_id: int):
    for p in PLAYLISTS:
        if p["id"] == playlist_id:
            return p
    raise HTTPException(status_code=404, detail="Playlist not found")


@app.get("/api/playlists/{playlist_id}/songs", response_model=list[Song])
async def get_playlist_songs(playlist_id: int):
    playlist = None
    for p in PLAYLISTS:
        if p["id"] == playlist_id:
            playlist = p
            break
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    song_ids = playlist["song_ids"]
    result = []
    for song in SONGS:
        if song["id"] in song_ids:
            result.append(song)
    return result


@app.get("/api/songs", response_model=list[Song])
async def get_songs():
    return SONGS


@app.get("/api/songs/{song_id}", response_model=Song)
async def get_song(song_id: int):
    for s in SONGS:
        if s["id"] == song_id:
            return s
    raise HTTPException(status_code=404, detail="Song not found")


@app.get("/api/artists", response_model=list[Artist])
async def get_artists():
    return ARTISTS


@app.get("/api/player", response_model=PlayerState)
async def get_player_state():
    return PLAYER_STATE


@app.post("/api/player/play")
async def play():
    PLAYER_STATE["is_playing"] = True
    return {"status": "playing", "progress": PLAYER_STATE["progress"]}


@app.post("/api/player/pause")
async def pause():
    PLAYER_STATE["is_playing"] = False
    return {"status": "paused", "progress": PLAYER_STATE["progress"]}


@app.post("/api/player/toggle")
async def toggle():
    PLAYER_STATE["is_playing"] = not PLAYER_STATE["is_playing"]
    return {
        "status": "playing" if PLAYER_STATE["is_playing"] else "paused",
        "progress": PLAYER_STATE["progress"],
    }


@app.post("/api/player/next")
async def next_song():
    playlist = PLAYER_STATE["playlist"]
    current_index = PLAYER_STATE["current_index"]
    next_index = (current_index + 1) % len(playlist)
    PLAYER_STATE["current_index"] = next_index
    next_song_id = playlist[next_index]
    for s in SONGS:
        if s["id"] == next_song_id:
            PLAYER_STATE["current_song_id"] = next_song_id
            PLAYER_STATE["current_song"] = {
                "id": s["id"],
                "title": s["title"],
                "artist_name": s["artist_name"],
                "album_name": s["album_name"],
                "album_cover": s["album_cover"],
                "duration": s["duration"],
            }
            PLAYER_STATE["progress"] = 0
            break
    return {
        "current_song": PLAYER_STATE["current_song"],
        "index": next_index,
    }


@app.post("/api/player/prev")
async def prev_song():
    playlist = PLAYER_STATE["playlist"]
    current_index = PLAYER_STATE["current_index"]
    prev_index = (current_index - 1) % len(playlist)
    PLAYER_STATE["current_index"] = prev_index
    prev_song_id = playlist[prev_index]
    for s in SONGS:
        if s["id"] == prev_song_id:
            PLAYER_STATE["current_song_id"] = prev_song_id
            PLAYER_STATE["current_song"] = {
                "id": s["id"],
                "title": s["title"],
                "artist_name": s["artist_name"],
                "album_name": s["album_name"],
                "album_cover": s["album_cover"],
                "duration": s["duration"],
            }
            PLAYER_STATE["progress"] = 0
            break
    return {
        "current_song": PLAYER_STATE["current_song"],
        "index": prev_index,
    }


@app.get("/health")
async def health():
    return {"status": "ok"}
