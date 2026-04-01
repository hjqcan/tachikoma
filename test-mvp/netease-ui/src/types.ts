export interface PlaylistCreator {
  id: number;
  name: string;
}

export interface Playlist {
  id: number;
  name: string;
  cover_url: string;
  track_count: number;
  song_ids: number[];
  play_count: number;
  comment_count: number;
  tags: string[];
  creator: PlaylistCreator;
  created_at: string;
}

export interface Song {
  id: number;
  title: string;
  artist_id: number;
  artist_name: string;
  album_name: string;
  album_cover: string;
  duration: number;
  play_count: number;
  comment_count: number;
  like_count: number;
}

export interface PlayerSong {
  id: number;
  title: string;
  artist_name: string;
  album_name: string;
  album_cover: string;
  duration: number;
}

export interface PlayerState {
  current_song_id: number;
  current_song: PlayerSong;
  is_playing: boolean;
  progress: number;
  volume: number;
  play_mode: string;
  playlist: number[];
  current_index: number;
  is_liked: boolean;
}
