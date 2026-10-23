# Front page art

The sign-in and passkey pages (`client/ui/boxart.ts`) show the UFO Defense box art reflowed to the window:
the **ship** and the **title** lettering are cut from a scan of the US DOS front cover; the starfield and the
(deliberately dim) planet are painted by the page. The cut-outs live in `gamedata/FRONT/` (gitignored like the
rest of the game's files; the server serves just these two publicly at `/front/`, since the sign-in page needs
them before anyone has signed in) and are uploaded with `deploy-xcom.py --upload-gamedata`.

To rebuild them (Python 3.12, a few minutes, ~1 GB of models):

```sh
python -m venv venv && venv/Scripts/python -m pip install rembg onnxruntime opencv-python-headless pillow numpy
python -m venv upvenv && upvenv/Scripts/python -m pip install spandrel opencv-python-headless pillow numpy
curl -LO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
# cover.jpg: the US DOS front cover, 682x800 (MobyGames, "Front Cover for X-COM: UFO Defense (DOS)")
venv/Scripts/python ship_mask.py cover.jpg work birefnet-general          # the ship's mask (BiRefNet)
upvenv/Scripts/python front_art.py cover.jpg work/mask-birefnet-general.png RealESRGAN_x4plus.pth ../../gamedata/FRONT
```

`ship_mask.py` crops the art inside the cover's frame and asks BiRefNet for the ship's mask; `front_art.py`
paints out the cover's frame line where it crosses the lettering, lifts the white-and-green title off the
background, and upscales both cut-outs 4x with Real-ESRGAN (saved at 3x as WebP).
