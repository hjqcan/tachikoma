import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_get_playlists():
    r = client.get("/api/playlists")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) == 4
    assert "id" in data[0]
    assert "name" in data[0]


def test_get_playlist_by_id():
    r = client.get("/api/playlists/10001")
    assert r.status_code == 200
    assert r.json()["name"] == "周杰伦经典合集"


def test_get_playlist_not_found():
    r = client.get("/api/playlists/99999")
    assert r.status_code == 404


def test_get_playlist_songs():
    r = client.get("/api/playlists/10001/songs")
    assert r.status_code == 200
    songs = r.json()
    assert isinstance(songs, list)
    assert len(songs) == 4
    assert all("title" in s for s in songs)


def test_get_playlist_songs_not_found():
    r = client.get("/api/playlists/99999/songs")
    assert r.status_code == 404


def test_get_songs():
    r = client.get("/api/songs")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) == 10


def test_get_song_by_id():
    r = client.get("/api/songs/2001")
    assert r.status_code == 200
    assert r.json()["title"] == "晴天"


def test_get_song_not_found():
    r = client.get("/api/songs/99999")
    assert r.status_code == 404


def test_get_artists():
    r = client.get("/api/artists")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 4


def test_get_player_state():
    r = client.get("/api/player")
    assert r.status_code == 200
    data = r.json()
    assert data["is_playing"] is True
    assert "current_song" in data


def test_player_play_pause():
    # Pause
    r = client.post("/api/player/pause")
    assert r.status_code == 200
    assert r.json()["status"] == "paused"

    # Play
    r = client.post("/api/player/play")
    assert r.status_code == 200
    assert r.json()["status"] == "playing"


def test_player_toggle():
    # Initially playing
    r = client.post("/api/player/toggle")
    assert r.json()["status"] == "paused"

    r = client.post("/api/player/toggle")
    assert r.json()["status"] == "playing"


def test_player_next_prev():
    r = client.post("/api/player/next")
    assert r.status_code == 200
    assert r.json()["index"] == 1
    assert "current_song" in r.json()

    r = client.post("/api/player/prev")
    assert r.status_code == 200
    assert r.json()["index"] == 0


def test_cors_headers():
    r = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 200
    assert "access-control-allow-origin" in r.headers
