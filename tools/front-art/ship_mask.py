"""Step 1: the ship's mask from the cover scan, with an AI background-removal model (rembg)."""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from rembg import remove, new_session

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
img = Image.open(src).convert("RGB")
# the art inside the cover's white frame (title and logo cropped away as much as possible)
box = (126, 106, 657, 700)
crop = img.crop(box)
crop.save(out / "crop.png")
for model in sys.argv[3:]:
    sess = new_session(model)
    mask = remove(crop, session=sess, only_mask=True)
    mask.save(out / f"mask-{model}.png")
    a = np.asarray(mask)
    print(model, "coverage", round((a > 128).mean(), 3))
