import os
from PIL import Image, ImageDraw

def create_gradient_icon(size):
    # Create the final RGBA image with transparent background
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # Create the mask image (grayscale 'L') for the icon shape
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    
    # Calculate dimensions based on size
    # Mail icon rectangle typically has 20x16 ratio (1.25).
    # We add padding to keep it neat inside tab circles.
    padding = max(1, int(size * 0.12))
    
    x_min = padding
    x_max = size - padding
    
    # Height is smaller than width (lucide-react mail icon style)
    width = x_max - x_min
    height = int(width * 0.8)
    
    y_min = (size - height) // 2
    y_max = y_min + height
    
    # Stroke thickness scales with icon size
    stroke = max(1, int(size * 0.08))
    
    # Draw envelope body rectangle outline
    draw.rectangle([x_min, y_min, x_max, y_max], outline=255, width=stroke)
    
    # Draw flap lines (V-shape)
    # The flap starts at the top corners and meets in the middle of the envelope
    flap_start_y = y_min + stroke // 2
    flap_mid_x = size // 2
    flap_mid_y = y_min + int(height * 0.6)
    
    # Use multiple lines to create a clean connected V shape
    draw.line([(x_min, flap_start_y), (flap_mid_x, flap_mid_y), (x_max, flap_start_y)], fill=255, width=stroke, joint="round")
    
    # Create the gradient image (diagonally from bottom-left to top-right or top-left to bottom-right)
    # Start: Monokai Pro Pink (#ff6188) -> rgb(255, 97, 136)
    # End: Monokai Pro Purple (#ab9df2) -> rgb(171, 157, 242)
    gradient = Image.new("RGBA", (size, size))
    for y in range(size):
        for x in range(size):
            # Calculate gradient factor diagonally
            factor = (x + y) / (2.0 * size)
            r = int(255 + (171 - 255) * factor)
            g = int(97 + (157 - 97) * factor)
            b = int(136 + (242 - 136) * factor)
            gradient.putpixel((x, y), (r, g, b, 255))
            
    # Composite gradient onto the final image using the mask
    img.paste(gradient, (0, 0), mask)
    return img

def main():
    public_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../public"))
    os.makedirs(public_dir, exist_ok=True)
    
    sizes = [
        (16, "favicon-16.png"),
        (32, "favicon-32.png"),
        (48, "favicon-48.png"),
        (180, "apple-touch-icon.png"),
        (192, "favicon-192.png"),
        (512, "favicon-512.png")
    ]
    
    for size, name in sizes:
        icon_path = os.path.join(public_dir, name)
        img = create_gradient_icon(size)
        img.save(icon_path, "PNG")
        print(f"Generated {name} ({size}x{size})")

if __name__ == "__main__":
    main()
